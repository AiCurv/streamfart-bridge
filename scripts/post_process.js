#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────
 * M3U Playlist Scraping & Post-Processing Engine
 * ─────────────────────────────────────────────────────────────────
 *
 * Reads the transfer results, extracts direct stream URLs from
 * Storage.to landing pages (via cheerio HTML parsing), and builds
 * a standard #EXTM3U playlist file for multi-file transactions.
 *
 * For single files: sends the direct link back to Telegram.
 * For collections: aggregates into .m3u and sends as document.
 *
 * Usage: node scripts/post_process.js <payload.json> <results.json>
 * ─────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── Argument validation ───
const [,, payloadPath, resultsPath] = process.argv;
if (!payloadPath || !resultsPath) {
  console.error('Usage: node post_process.js <payload.json> <results.json>');
  process.exit(1);
}

// ─── Load data ───
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

const chatId = payload.chat_id || results.chat_id || '';
const mode = payload.mode || results.mode || 'single';

console.log(`Post-process: mode=${mode}, files=${results.files?.length || 0}, chat_id=${chatId}`);

/**
 * Fetch HTML content from a URL (Node.js native, no axios dependency needed).
 */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('Fetch timeout')), 30000);
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeout);
        return fetchHtml(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timeout); resolve(data); });
      res.on('error', err => { clearTimeout(timeout); reject(err); });
    }).on('error', err => { clearTimeout(timeout); reject(err); });
  });
}

/**
 * Extract direct streaming URL from a Storage.to landing page.
 * Parses the HTML for <video>, <source>, or <iframe> elements that
 * reference CDN endpoints. Uses simple regex-based extraction to
 * avoid heavy cheerio dependency in the runner environment.
 */
async function extractDirectUrl(publicUrl) {
  if (!publicUrl || publicUrl === 'null') return null;

  // If it's already a direct/cdn URL, return as-is
  if (publicUrl.includes('cdn.storage.to') || publicUrl.includes('/r/')) {
    return publicUrl;
  }

  // Only scrape storage.to pages
  if (!publicUrl.includes('storage.to')) {
    return publicUrl;
  }

  try {
    console.log(`  Scraping landing page: ${publicUrl}`);
    const html = await fetchHtml(publicUrl);

    // Strategy 1: Look for <video> or <source> src attributes with CDN URLs
    let match = html.match(/<source[^>]+src=["']([^"']*cdn\.storage\.to[^"']*)["']/i);
    if (match) {
      console.log(`  Found CDN URL via <source>: ${match[1]}`);
      return match[1].replace(/&amp;/g, '&');
    }

    match = html.match(/<video[^>]+src=["']([^"']*cdn\.storage\.to[^"']*)["']/i);
    if (match) {
      console.log(`  Found CDN URL via <video>: ${match[1]}`);
      return match[1].replace(/&amp;/g, '&');
    }

    // Strategy 2: Look for JavaScript variable assignments with CDN URLs
    match = html.match(/(?:src|url|streamUrl|videoUrl|file)\s*[:=]\s*["']([^"']*cdn\.storage\.to[^"']*)["']/i);
    if (match) {
      console.log(`  Found CDN URL via JS var: ${match[1]}`);
      return match[1].replace(/&amp;/g, '&');
    }

    // Strategy 3: Look for any storage.to CDN URLs in the page
    match = html.match(/https?:\/\/cdn\.storage\.to\/[^\s"'<>]+/);
    if (match) {
      console.log(`  Found CDN URL via generic scan: ${match[0]}`);
      return match[0].replace(/&amp;/g, '&');
    }

    // Strategy 4: Look for /r/ raw endpoint patterns
    match = html.match(/https?:\/\/storage\.to\/r\/[^\s"'<>]+/);
    if (match) {
      console.log(`  Found raw endpoint: ${match[0]}`);
      return match[0].replace(/&amp;/g, '&');
    }

    console.log(`  No CDN URL found in landing page for: ${publicUrl}`);
    return null;
  } catch (err) {
    console.error(`  Scraping failed for ${publicUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Build a standard #EXTM3U playlist from an array of file objects.
 */
function buildM3U(files) {
  let m3u = '#EXTM3U\n';
  for (const file of files) {
    const name = file.name || 'Unknown';
    const url = file.direct_url || file.public_url || '';
    if (url) {
      m3u += `#EXTINF:-1,${name}\n${url}\n`;
    }
  }
  return m3u;
}

/**
 * Send a text message via Telegram Bot API.
 */
function sendTelegramMessage(chatId, text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return Promise.resolve();

  const data = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => { console.log(`Telegram msg sent: ${res.statusCode}`); resolve(); });
    });
    req.on('error', (err) => { console.error(`Telegram send error: ${err.message}`); resolve(); });
    req.write(data);
    req.end();
  });
}

/**
 * Send a document (M3U file) via Telegram Bot API.
 */
function sendTelegramDocument(chatId, m3uContent) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return Promise.resolve();

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const m3uBuffer = Buffer.from(m3uContent, 'utf8');

  let body = '';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n📻 M3U Playlist — open in VLC / MX Player\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="playlist.m3u"\r\nContent-Type: audio/x-mpegurl\r\n\r\n`;

  const headerBuf = Buffer.from(body, 'utf8');
  const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const payloadBuf = Buffer.concat([headerBuf, m3uBuffer, footerBuf]);

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${botToken}/sendDocument`,
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payloadBuf.length },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let rbody = '';
      res.on('data', chunk => rbody += chunk);
      res.on('end', () => { console.log(`Telegram doc sent: ${res.statusCode}`); resolve(); });
    });
    req.on('error', (err) => { console.error(`Telegram doc error: ${err.message}`); resolve(); });
    req.write(payloadBuf);
    req.end();
  });
}

// ─── Main processing ───
(async () => {
  try {
    const files = results.files || [];
    if (files.length === 0) {
      console.log('No files in results — nothing to post-process');
      process.exit(0);
    }

    // For each file, try to extract the direct streaming URL
    console.log(`\nExtracting direct URLs for ${files.length} file(s)...`);
    for (const file of files) {
      // If direct_url is already set, skip scraping
      if (file.direct_url && file.direct_url !== 'null' && file.direct_url.includes('cdn')) {
        console.log(`  ✓ ${file.name}: direct URL already present`);
        continue;
      }

      const extractedUrl = await extractDirectUrl(file.public_url);
      if (extractedUrl) {
        file.direct_url = extractedUrl;
        console.log(`  ✓ ${file.name}: extracted ${extractedUrl}`);
      } else {
        // Fallback: use public_url as direct_url
        file.direct_url = file.direct_url || file.public_url || '';
        console.log(`  ⚠ ${file.name}: no CDN URL found, using fallback`);
      }
    }

    // Write updated results
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`\nUpdated results written to ${resultsPath}`);

    // Build M3U if collection mode
    if (mode === 'collection' && files.length > 1) {
      const m3uContent = buildM3U(files);
      const m3uPath = '/tmp/playlist.m3u';
      fs.writeFileSync(m3uPath, m3uContent);
      console.log(`\nM3U playlist written to ${m3uPath} (${files.length} entries)`);
      console.log(m3uContent);

      // Send M3U to Telegram
      await sendTelegramDocument(chatId, m3uContent);
    }

    // Send summary message
    if (mode === 'single' && files.length === 1) {
      const f = files[0];
      const msg = `✅ Bridge complete!\n\n📄 Page: ${f.public_url}\n🔗 Direct: ${f.direct_url}\n⏰ Expires: ${f.expires_at || '3 days'}`;
      await sendTelegramMessage(chatId, msg);
    } else if (files.length > 1) {
      let msg = `✅ Collection bridge complete! ${files.length} files uploaded.\n\n`;
      for (const f of files) {
        msg += `• ${f.name}: ${f.public_url}\n`;
      }
      msg += `\n📻 M3U playlist sent as attachment.`;
      await sendTelegramMessage(chatId, msg);
    }

    console.log('\nPost-processing complete');
  } catch (err) {
    console.error('Post-process error:', err);
    // Attempt to notify about failure
    await sendTelegramMessage(chatId, `❌ Post-processing failed: ${err.message}`).catch(() => {});
    process.exit(1);
  }
})();
