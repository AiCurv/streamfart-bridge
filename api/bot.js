import axios from 'axios';

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

function extractUrls(text) {
  if (!text) return [];
  return [...new Set((text.match(URL_RE) || []).map(u => u.replace(/[),.;]+$/, '')))];
}

function isAllowed(req) {
  const allowed = process.env.ALLOWED_TELEGRAM_USER_ID;
  const fromId = req.body?.message?.from?.id;
  if (!allowed || !fromId) return false;
  return String(fromId).trim() === String(allowed).trim();
}

async function dispatch(urls, chatId, mode) {
  const ghToken = process.env.GH_PAT_TOKEN;
  const repo = process.env.GH_REPO_OWNER_AND_NAME;
  await axios.post(
    `https://api.github.com/repos/${repo}/dispatches`,
    {
      event_type: 'bridgectl_v2',
      client_payload: { urls, chat_id: String(chatId), mode },
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

async function reply(chatId, text) {
  await axios.post(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    { chat_id: chatId, text, parse_mode: 'HTML' }
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const message = req.body?.message;
  if (!message) return res.status(200).send('No message');

  // Security lock
  if (!isAllowed(req)) {
    console.log(`Blocked user id=${message.from?.id}`);
    return res.status(200).send('Unauthorized');
  }

  const chatId = message.chat.id;
  const text = (message.text || message.caption || '').trim();
  const lower = text.toLowerCase();

  // Commands
  if (lower === '/start' || lower === '/help') {
    await reply(
      chatId,
      `👋 <b>Streamfart Bridge Bot</b>\n\n` +
      `Send me a <b>storage.to</b> link and I'll fetch it for you as a direct raw URL.\n\n` +
      `<b>Supported hosts:</b>\n` +
      `• storage.to (e.g. https://storage.to/ABCD1234)\n` +
      `• pixeldrain.com / pixeldrain.dev\n` +
      `• any direct file URL\n\n` +
      `<b>Single link:</b> just paste it\n` +
      `<b>Multiple links:</b> paste 2+ in one message → I'll make a collection + M3U playlist\n\n` +
      `Links expire in 3 days (anonymous tier).\n` +
      `Reply to the original message to add a note — bot ignores replies for now.`
    );
    return res.status(200).send('start');
  }

  if (lower === '/id') {
    await reply(chatId, `Your id: <code>${message.from.id}</code>`);
    return res.status(200).send('id');
  }

  // URL extraction
  const urls = extractUrls(text);
  if (urls.length === 0) {
    await reply(chatId, '🤔 No URL found. Send me a link to a file (storage.to, pixeldrain, direct). Type /help for details.');
    return res.status(200).send('no url');
  }

  const mode = urls.length === 1 ? 'single' : 'collection';

  try {
    await dispatch(urls, chatId, mode);
    if (mode === 'single') {
      await reply(chatId, `🔄 Fetching 1 link…\n${urls[0]}`);
    } else {
      await reply(chatId, `🔄 Fetching ${urls.length} links as a collection + M3U…`);
    }
    return res.status(200).send('dispatched');
  } catch (err) {
    console.error('dispatch error', err?.response?.data || err.message);
    await reply(chatId, `❌ Could not start the job: ${err.message}`);
    return res.status(500).send('Internal Error');
  }
}
