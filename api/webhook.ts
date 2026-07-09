import axios from 'axios';

/* ──────────── Constants & Helpers ──────────── */

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

function extractUrls(text: string): string[] {
  if (!text) return [];
  return [...new Set((text.match(URL_RE) || []).map(u => u.replace(/[),.;]+$/, '')))];
}

/**
 * Security lock: only the owner's Telegram User ID is authorized.
 * Every incoming request is checked against TELEGRAM_USER_ID env var.
 */
function isOwner(fromId: number | undefined): boolean {
  const allowed = process.env.TELEGRAM_USER_ID;
  if (!allowed || fromId === undefined) return false;
  return String(fromId).trim() === String(allowed).trim();
}

/* ──────────── Telegram API wrappers ──────────── */

const BOT_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function reply(chatId: number | string, text: string, parseMode: string = 'HTML') {
  await axios.post(`${BOT_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
  });
}

async function sendDocument(chatId: number | string, filePath: string, caption?: string) {
  const fs = await import('fs');
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', fs.createReadStream(filePath), { filename: 'playlist.m3u' });
  if (caption) form.append('caption', caption);

  await axios.post(`${BOT_API}/sendDocument`, form, {
    headers: form.getHeaders(),
  });
}

/**
 * Register persistent bot commands via setMyCommands.
 * This ensures /start, /upload, /multiple appear in the Telegram menu.
 */
async function registerBotCommands() {
  try {
    await axios.post(`${BOT_API}/setMyCommands`, {
      commands: [
        { command: 'start', description: 'Show welcome message and usage info' },
        { command: 'upload', description: 'Upload a single URL to Storage.to bridge' },
        { command: 'multiple', description: 'Batch upload multiple URLs (text list or .txt file)' },
      ],
    });
    console.log('Bot commands registered successfully');
  } catch (err: any) {
    console.error('Failed to register bot commands:', err?.response?.data || err.message);
  }
}

/* ──────────── GitHub repository_dispatch ──────────── */

/**
 * Fire a repository_dispatch event with the ENTIRE payload encoded as a single
 * top-level "data" string. This avoids the nested-expression resolution bug
 * where ${{ toJSON(github.event.client_payload.urls) }} evaluates to empty
 * inside GitHub Actions.
 *
 * The runner workflow reads PAYLOAD_DATA env var (the full JSON string) and
 * parses it with jq to extract urls, chat_id, and mode.
 */
async function dispatchBridge(urls: string[], chatId: number | string, mode: string) {
  const ghToken = process.env.GH_PAT_TOKEN;
  const repo = process.env.GH_REPO_OWNER_AND_NAME;

  if (!ghToken || !repo) {
    throw new Error('Missing GH_PAT_TOKEN or GH_REPO_OWNER_AND_NAME env vars');
  }

  // Encode the entire payload as a single JSON string under "data"
  const payload = JSON.stringify({ urls, chat_id: String(chatId), mode });

  await axios.post(
    `https://api.github.com/repos/${repo}/dispatches`,
    {
      event_type: 'bridgectl_v2',
      client_payload: { data: payload },
    },
    {
      headers: {
        Authorization: `Bearer ${ghToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
}

/* ──────────── Main webhook handler ──────────── */

let commandsRegistered = false;

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Lazy-register bot commands on first webhook hit
  if (!commandsRegistered) {
    commandsRegistered = true;
    registerBotCommands(); // fire-and-forget
  }

  const message = req.body?.message;
  if (!message) return res.status(200).send('No message');

  // ─── Security Lock: validate sender ───
  const fromId = message.from?.id;
  if (!isOwner(fromId)) {
    console.log(`BLOCKED: unauthorized user id=${fromId}`);
    await reply(message.chat.id, '⛔ Access denied. This bot is private.');
    return res.status(200).send('Unauthorized');
  }

  const chatId = message.chat.id;
  const text = (message.text || message.caption || '').trim();
  const lower = text.toLowerCase();

  /* ──── /start ──── */
  if (lower === '/start') {
    await reply(
      chatId,
      `👋 <b>Streamfart Bridge Bot V2</b>\n\n` +
      `Your personal Storage.to bridge — send me URLs and I'll download + re-upload them.\n\n` +
      `<b>Commands:</b>\n` +
      `• /start — This help message\n` +
      `• /upload — Upload a single URL\n` +
      `• /multiple — Batch upload (paste URLs or attach a .txt file)\n\n` +
      `<b>Quick use:</b>\n` +
      `Just paste any URL(s) directly — no command needed for 1+ links.\n\n` +
      `<b>Supported sources:</b>\n` +
      `• storage.to (e.g. https://storage.to/ABCD1234)\n` +
      `• pixeldrain.com / pixeldrain.dev\n` +
      `• Any direct file URL\n\n` +
      `⚠️ Links expire in 3 days (anonymous tier).`
    );
    return res.status(200).send('start');
  }

  /* ──── /upload ──── */
  if (lower === '/upload') {
    await reply(
      chatId,
      `📤 <b>Upload Mode</b>\n\n` +
      `Paste a single URL in your next message and I'll bridge it to Storage.to.\n\n` +
      `Supported: storage.to, pixeldrain, direct links.`
    );
    return res.status(200).send('upload');
  }

  /* ──── /multiple ──── */
  if (lower === '/multiple') {
    await reply(
      chatId,
      `📋 <b>Multiple Upload Mode</b>\n\n` +
      `Send me URLs in one of these formats:\n\n` +
      `1️⃣ <b>Line-separated text:</b>\n` +
      `<code>https://storage.to/abc\nhttps://storage.to/def\nhttps://pixeldrain.com/xyz</code>\n\n` +
      `2️⃣ <b>.txt file attachment:</b>\n` +
      `Upload a .txt file containing one URL per line (caption: /multiple)\n\n` +
      `I'll batch-bridge all links and send you a M3U playlist.`
    );
    return res.status(200).send('multiple_help');
  }

  /* ──── Handle .txt file upload (for /multiple mode) ──── */
  if (message.document && message.document.mime_type === 'text/plain') {
    const fileName = message.document.file_name || 'urls.txt';

    // Only accept .txt files
    if (!fileName.endsWith('.txt')) {
      await reply(chatId, '❌ Please upload a .txt file containing URLs (one per line).');
      return res.status(200).send('bad_file');
    }

    try {
      // Download the file from Telegram
      const fileInfo = await axios.get(
        `${BOT_API}/getFile?file_id=${message.document.file_id}`
      );
      const filePath = fileInfo.data?.result?.file_path;
      if (!filePath) throw new Error('Could not get file path from Telegram');

      const fileContent = await axios.get(
        `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`,
        { responseType: 'text' }
      );

      const urls = extractUrls(fileContent.data);
      if (urls.length === 0) {
        await reply(chatId, '❌ No URLs found in the uploaded file.');
        return res.status(200).send('no_urls_in_file');
      }

      const mode = urls.length === 1 ? 'single' : 'collection';
      await dispatchBridge(urls, chatId, mode);
      await reply(
        chatId,
        `🔄 Bridging <b>${urls.length}</b> URL(s) from file <code>${fileName}</code>…\n` +
        (mode === 'collection' ? '📦 Collection + M3U playlist will follow.' : '')
      );
      return res.status(200).send('dispatched_file');
    } catch (err: any) {
      console.error('File processing error:', err?.response?.data || err.message);
      await reply(chatId, `❌ Failed to process file: ${err.message}`);
      return res.status(500).send('File Error');
    }
  }

  /* ──── URL extraction from message text ──── */
  const urls = extractUrls(text);
  if (urls.length === 0) {
    await reply(
      chatId,
      '🤔 No URL found. Send me a link to bridge, or type /multiple for batch mode.'
    );
    return res.status(200).send('no_url');
  }

  // Determine mode based on URL count
  const mode = urls.length === 1 ? 'single' : 'collection';

  try {
    await dispatchBridge(urls, chatId, mode);
    if (mode === 'single') {
      await reply(chatId, `🔄 Bridging 1 link…\n${urls[0]}`);
    } else {
      await reply(
        chatId,
        `🔄 Bridging <b>${urls.length}</b> links as collection + M3U playlist…`
      );
    }
    return res.status(200).send('dispatched');
  } catch (err: any) {
    console.error('Dispatch error:', err?.response?.data || err.message);
    await reply(chatId, `❌ Could not start bridge job: ${err.message}`);
    return res.status(500).send('Internal Error');
  }
}
