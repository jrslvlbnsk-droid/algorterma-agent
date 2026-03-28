const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: { interval: 2000, autoStart: true, params: { timeout: 10 } }
});

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 30000 });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = 'jrslvlbnsk-droid';

const projects = {
  algorterma: { repo: 'algorterma-web', file: 'index.html', name: 'AlgorTerma', url: 'algorterma.cz' },
  neumimplavat: { repo: 'neumimplavat', file: 'index.html', name: 'Neumimplavat', url: 'neumimplavat.cz' }
};

const projectState = {};
const conversationHistory = {};

async function getFile(repo, filepath) {
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${filepath}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!res.ok) throw new Error(`Soubor nenalezen: ${filepath}`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { content, sha: data.sha };
}

async function updateFile(repo, filepath, newContent, sha, message) {
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${filepath}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: message || 'Aktualizace přes agenta',
      content: Buffer.from(newContent).toString('base64'),
      sha: sha
    })
  });
  if (!res.ok) { const err = await res.json(); throw new Error(err.message); }
  return await res.json();
}

async function callGroq(systemPrompt, history) {
  for (const limit of [20000, 12000, 6000]) {
    const truncated = systemPrompt.replace(/AKTUÁLNÍ OBSAH SOUBORU:\n[\s\S]*/,
      `AKTUÁLNÍ OBSAH SOUBORU:\n${systemPrompt.match(/AKTUÁLNÍ OBSAH SOUBORU:\n([\s\S]*)/)?.[1]?.substring(0, limit) || ''}`
    );
    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 8000,
        messages: [
          { role: 'system', content: truncated },
          ...history
        ]
      });
      return response.choices[0].message.content;
    } catch (e) {
      if ((e.status === 413 || e.status === 429) && limit > 6000) continue;
      throw e;
    }
  }
}

function extractCode(responseText) {
  let match = responseText.match(/===KOD_START===\n?([\s\S]*?)\n?===KOD_END===/);
  if (match) return match[1].trim();
  match = responseText.match(/```(?:html)?\n?([\s\S]*?)\n?```/);
  if (match) return match[1].trim();
  return null;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  if (text === '/start' || text === '/help') {
    bot.sendMessage(chatId,
      '👋 Jsem tvůj AI agent!\n\n' +
      '📁 *Projekty:*\n' +
      '/algorterma — přepnout na AlgorTerma\n' +
      '/neumimplavat — přepnout na Neumimplavat\n' +
      '/projekt — zobrazit aktuální projekt\n\n' +
      '💡 *Co umím:*\n' +
      '• Číst soubory z GitHubu\n' +
      '• Upravovat a ukládat změny\n' +
      '• Railway automaticky nasadí změny\n\n' +
      'Prostě mi napiš co chceš udělat!',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '/algorterma') {
    projectState[chatId] = 'algorterma';
    conversationHistory[chatId] = [];
    bot.sendMessage(chatId, '✅ Přepnuto na projekt *AlgorTerma*', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/neumimplavat') {
    projectState[chatId] = 'neumimplavat';
    conversationHistory[chatId] = [];
    bot.sendMessage(chatId, '✅ Přepnuto na projekt *Neumimplavat*', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/projekt') {
    const current = projectState[chatId] || 'algorterma';
    const p = projects[current];
    bot.sendMessage(chatId, `📁 Aktuální projekt: *${p.name}* (${p.url})`, { parse_mode: 'Markdown' });
    return;
  }

  const currentProject = projectState[chatId] || 'algorterma';
  const p = projects[currentProject];
  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];

  bot.sendMessage(chatId, `⏳ Pracuji na tom... (${p.name})`);

  try {
    let fileContent = '';
    let fileSha = null;

    try {
      const fileData = await getFile(p.repo, p.file);
      fileContent = fileData.content;
      fileSha = fileData.sha;
    } catch (e) {
      bot.sendMessage(chatId, `⚠️ Nepodařilo se načíst soubor z GitHubu: ${e.message}`);
      return;
    }

    const systemPrompt = `Jsi AI agent spravující web ${p.name} (${p.url}). Máš přístup k souboru ${p.file} v GitHub repozitáři ${p.repo}.

AKTUÁLNÍ OBSAH SOUBORU:
${fileContent}

Pokud tě uživatel požádá o úpravu webu:
1. Uprav HTML kód podle požadavku
2. Vrať odpověď PŘESNĚ v tomto formátu (bez markdown bloků, bez backticks):

ZMĚNA: [popis co jsi změnil]
===KOD_START===
[celý upravený kód]
===KOD_END===

DŮLEŽITÉ: Nepoužívej markdown bloky ani backticks. Použij POUZE značky ===KOD_START=== a ===KOD_END===.
Pokud se jen ptá nebo chce informace, odpověz normálně bez kódu.
Odpovídej česky, stručně a přátelsky.`;

    conversationHistory[chatId].push({ role: 'user', content: text });
    if (conversationHistory[chatId].length > 20) {
      conversationHistory[chatId] = conversationHistory[chatId].slice(-20);
    }

    const responseText = await callGroq(systemPrompt, conversationHistory[chatId]);
    conversationHistory[chatId].push({ role: 'assistant', content: responseText });

    const hasKodMarkers = responseText.includes('===KOD_START===') && responseText.includes('===KOD_END===');
    const hasMarkdown = responseText.includes('```');

    if (hasKodMarkers || hasMarkdown) {
      const novyKod = extractCode(responseText);
      const zmenaMatch = responseText.match(/ZMĚNA: (.+)/);

      if (novyKod) {
        const popis = zmenaMatch ? zmenaMatch[1] : 'Aktualizace přes agenta';
        await updateFile(p.repo, p.file, novyKod, fileSha, popis);
        bot.sendMessage(chatId,
          `✅ *Hotovo!*\n\n📝 ${popis}\n\n🚀 Změny jsou na GitHubu, Railway nasazuje...`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(chatId, '⚠️ Kód se nepodařilo extrahovat. Zkus to znovu.');
      }
    } else {
      bot.sendMessage(chatId, responseText.substring(0, 4000));
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, '❌ Chyba: ' + err.message);
  }
});

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Agent server běží na portu ${PORT}`); });
