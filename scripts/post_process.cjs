#!/usr/bin/env node
/**
 * M3U Playlist Scraping & Post-Processing Engine
 *
 * Reads the transfer results, extracts direct stream URLs from
 * Storage.to landing pages (via cheerio HTML parsing), and builds
 * a standard #EXTM3U playlist file for multi-file transactions.
 *
 * Usage: node scripts/post_process.js <payload.json> <results.json>
 */

const fs = require('fs');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const [,, payloadPath, resultsPath] = process.argv;
if (!payloadPath || !resultsPath) {
  console.error('Usage: node post_process.js <payload.json> <results.json>');
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

const chatId = payload.chat_id || results.chat_id || '';
const mode = payload.mode || results.mode || 'single';

console.log(`Post-process: mode=${mode}, files=${results.files?.length || 0}, chat_id=${chatId}`);

/**
 * Fetch HTML content from a URL.
 */
function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('Fetch timeout')), 30000);
    mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } }, (res) => {
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
 * Uses cheerio if available, falls back to regex-based extraction.
 */
async function extractDirectUrl(publicUrl) {
  if (!publicUrl || publicUrl === 'null') return null;
  if (publicUrl.includes('cdn.storage.to') || publicUrl.includes('/r/')) return publicUrl;
  if (!publicUrl.includes('storage.to')) return publicUrl;

  try {
    console.log(`  Scraping landing page: ${publicUrl}`);
    const html = await fetchHtml(publicUrl);

    // Try cheerio first (if installed)
    try {
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);

      // Check <video> -> <source> elements
      const sourceUrl = $('video source').attr('src') ||
                        $('video').attr('src') ||
                        $('source[type^="video/"]').attr('src');
      if (sourceUrl && sourceUrl.includes('cdn.storage.to')) {
        console.log(`  Found CDN URL via cheerio <source>: ${sourceUrl}`);
        return sourceUrl.replace(/&amp;/g, '&');
      }

      // Check <iframe> for embedded player
      const iframeSrc = $('iframe').attr('src');
      if (iframeSrc && iframeSrc.includes('storage.to')) {
        console.log(`  Found iframe, following: ${iframeSrc}`);
        const iframeHtml = await fetchHtml(iframeSrc);
        const iframe$ = cheerio.load(iframeHtml);
        const iSourceUrl = iframe$('video source').attr('src') || iframe$('video').attr('src');
        if (iSourceUrl && iSourceUrl.includes('cdn.storage.to')) {
          return iSourceUrl.replace(/&amp;/g, '&');
        }
      }
    } catch (e) {
      // cheerio not available, fall through to regex
    }

    // Fallback: regex-based extraction
    let match;
    match = html.match(/<source[^>]+src=["']([^"']*cdn\.storage\.to[^"']*)["']/i);
    if (match) return match[1].replace(/&amp;/g, '&');

    match = html.match(/<video[^>]+src=["']([^"']*cdn\.storage\.to[^"']*)["']/i);
    if (match) return match[1].replace(/&amp;/g, '&');

    match = html.match(/(?:src|url|streamUrl|videoUrl|file)\s*[:=]\s*["']([^"']*cdn\.storage\.to[^"']*)["']/i);
    if (match) return match[1].replace(/&amp;/g, '&');

    match = html.match(/https?:\/\/cdn\.storage\.to\/[^\s"'<>]+/);
    if (match) return match[0].replace(/&amp;/g, '&');

    match = html.match(/https?:\/\/storage\.to\/r\/[^\s"'<>]+/);
    if (match) return match[0].replace(/&amp;/g, '&');

    console.log(`  No CDN URL found for: ${publicUrl}`);
    return null;
  } catch (err) {
    console.error(`  Scraping failed for ${publicUrl}: ${err.message}`);
    return null;
  }
}

/**
 * Build a standard #EXTM3U playlist.
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
 * Send a Telegram message.
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
 * Send a document via Telegram.
 */
function sendTelegramDocument(chatId, m3uContent) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return Promise.resolve();

  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const m3uBuffer = Buffer.from(m3uContent, 'utf8');

  let body = '';
  body += `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nM3U Playlist - open in VLC / MX Player\r\n`;
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

// ─── Main ───
(async () => {
  try {
    const files = results.files || [];
    if (files.length === 0) {
      console.log('No files in results — nothing to post-process');
      process.exit(0);
    }

    // Extract direct streaming URLs by scraping landing pages
    console.log(`\nExtracting direct URLs for ${files.length} file(s)...`);
    for (const file of files) {
      if (file.direct_url && file.direct_url !== 'null' && file.direct_url.includes('cdn')) {
        console.log(`  ok ${file.name}: direct URL already present`);
        continue;
      }

      const extractedUrl = await extractDirectUrl(file.public_url);
      if (extractedUrl) {
        file.direct_url = extractedUrl;
        console.log(`  ok ${file.name}: extracted ${extractedUrl}`);
      } else {
        file.direct_url = file.direct_url || file.public_url || '';
        console.log(`  warn ${file.name}: no CDN URL found, using fallback`);
      }
    }

    // Write updated results
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`\nUpdated results written to ${resultsPath}`);

    // Build and send M3U for collections
    if (mode === 'collection' && files.length > 1) {
      const m3uContent = buildM3U(files);
      const m3uPath = '/tmp/playlist.m3u';
      fs.writeFileSync(m3uPath, m3uContent);
      console.log(`\nM3U playlist written (${files.length} entries)`);
      await sendTelegramDocument(chatId, m3uContent);
    }

    // Send summary message
    if (mode === 'single' && files.length === 1) {
      const f = files[0];
      const msg = `Bridge complete!\n\nPage: ${f.public_url}\nDirect: ${f.direct_url}\nExpires: ${f.expires_at || '3 days'}`;
      await sendTelegramMessage(chatId, msg);
    } else if (files.length > 1) {
      let msg = `Collection bridge complete! ${files.length} files uploaded.\n\n`;
      for (const f of files) {
        msg += `- ${f.name}: ${f.public_url}\n`;
      }
      msg += `\nM3U playlist sent as attachment.`;
      await sendTelegramMessage(chatId, msg);
    }

    console.log('\nPost-processing complete');
  } catch (err) {
    console.error('Post-process error:', err);
    await sendTelegramMessage(chatId, `Post-processing failed: ${err.message}`).catch(() => {});
    process.exit(1);
  }
})();
