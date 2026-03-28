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
  if (!res.ok) throw new Error(`Soubor nenalezen: ${filepath} (${res.status})`);
  const data = await res.json();
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha };
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
      sha
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub chyba: ${err.message}`);
  }
  return await res.json();
}

async function getCommits(repo, filepath, count = 5) {
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/commits?path=${filepath}&per_page=${count}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!res.ok) throw new Error(`Nelze načíst historii (${res.status})`);
  return await res.json();
}

async function getFileAtCommit(repo, filepath, sha) {
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${filepath}?ref=${sha}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' }
  });
  if (!res.ok) throw new Error(`Commit nenalezen: ${sha}`);
  const data = await res.json();
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

async function callGroq(messages) {
  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 4000,
    messages
  });
  return response.choices[0].message.content;
}

function applyPatch(original, patch) {
  const findMatch = patch.match(/NAJDI:\n([\s\S]*?)\nNAHRAD:\n([\s\S]*?)(\nKONEC|$)/);
  if (!findMatch) return null;

  const find = findMatch[1].trim();
  const replace = findMatch[2].trim();

  if (!original.includes(find)) return null;

  return original.replace(find, replace);
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  const currentProject = projectState[chatId] || 'algorterma';
  const p = projects[currentProject];
  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];

  if (text === '/start' || text === '/help') {
    bot.sendMessage(chatId,
      '👋 Jsem tvůj AI agent!\n\n' +
      '📁 *Projekty:*\n' +
      '/algorterma — AlgorTerma\n' +
      '/neumimplavat — Neumimplavat\n' +
      '/projekt — aktuální projekt\n\n' +
      '🕐 *Historie:*\n' +
      '/history — posledních 5 commitů\n' +
      '/revert abc123 — vrátit soubor na commit\n\n' +
      'Prostě mi napiš co chceš změnit!',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '/algorterma') {
    projectState[chatId] = 'algorterma';
    conversationHistory[chatId] = [];
    bot.sendMessage(chatId, '✅ Přepnuto na *AlgorTerma*', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/neumimplavat') {
    projectState[chatId] = 'neumimplavat';
    conversationHistory[chatId] = [];
    bot.sendMessage(chatId, '✅ Přepnuto na *Neumimplavat*', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/projekt') {
    bot.sendMessage(chatId, `📁 Projekt: *${p.name}* (${p.url})\n📄 Soubor: \`${p.file}\``, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/history') {
    try {
      bot.sendMessage(chatId, '⏳ Načítám historii...');
      const commits = await getCommits(p.repo, p.file);
      const list = commits.map((c, i) =>
        `${i + 1}. \`${c.sha.substring(0, 7)}\` — ${c.commit.message}\n    📅 ${new Date(c.commit.author.date).toLocaleString('cs-CZ')}`
      ).join('\n\n');
      bot.sendMessage(chatId,
        `🕐 *Historie: ${p.file}*\n\n${list}\n\nPro vrácení: /revert [hash]`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ Chyba: ${e.message}`);
    }
    return;
  }

  if (text.startsWith('/revert ')) {
    const hash = text.replace('/revert ', '').trim();
    try {
      bot.sendMessage(chatId, `⏳ Vracím na verzi \`${hash}\`...`, { parse_mode: 'Markdown' });
      const oldContent = await getFileAtCommit(p.repo, p.file, hash);
      const current = await getFile(p.repo, p.file);
      await updateFile(p.repo, p.file, oldContent, current.sha, `Revert na ${hash}`);
      bot.sendMessage(chatId, `✅ Vráceno na verzi \`${hash}\``, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Chyba při revertu: ${e.message}`);
    }
    return;
  }

  // ── AI požadavek ──

  bot.sendMessage(chatId, `⏳ Pracuji na tom... (${p.name})`);

  try {
    const { content: fileContent, sha: fileSha } = await getFile(p.repo, p.file);

    // Krok 1: Groq identifikuje co změnit (bez celého souboru)
    const snippet = fileContent.substring(0, 8000);
    const snippetEnd = fileContent.length > 8000 ? fileContent.substring(fileContent.length - 2000) : '';

    const systemPrompt = `Jsi expert na HTML/CSS. Uživatel chce upravit webovou stránku.
Dostaneš začátek a konec souboru jako kontext. Tvým úkolem je vrátit PŘESNĚ tento formát:

POPIS: [co jsi změnil, česky]
NAJDI:
[přesný text z originálního souboru který má být nahrazen - musí být unikátní úsek]
NAHRAD:
[nový text který ho nahradí]
KONEC

PRAVIDLA:
- Text v NAJDI musí být přesná kopie z originálního souboru včetně mezer a odsazení
- Změň jen to co uživatel žádá, nic jiného
- Pokud je změna čistě textová (název, barva, text), najdi přesně ten element
- Nepiš nic jiného než výše uvedený formát
- Pokud to není úprava kódu ale otázka, odpověz normálně česky BEZ formátu NAJDI/NAHRAD`;

    conversationHistory[chatId].push({ role: 'user', content: text });
    if (conversationHistory[chatId].length > 10) {
      conversationHistory[chatId] = conversationHistory[chatId].slice(-10);
    }

    const contextMsg = `Začátek souboru:\n${snippet}\n\n${snippetEnd ? `Konec souboru:\n${snippetEnd}` : ''}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Obsah souboru:\n${contextMsg}` },
      { role: 'assistant', content: 'Rozumím obsahu souboru.' },
      ...conversationHistory[chatId]
    ];

    const responseText = await callGroq(messages);
    conversationHistory[chatId].push({ role: 'assistant', content: responseText });

    if (responseText.includes('NAJDI:') && responseText.includes('NAHRAD:')) {
      const patchedContent = applyPatch(fileContent, responseText);
      const popisMatch = responseText.match(/POPIS: (.+)/);
      const popis = popisMatch ? popisMatch[1] : 'Úprava webu';

      if (patchedContent) {
        await updateFile(p.repo, p.file, patchedContent, fileSha, popis);
        bot.sendMessage(chatId,
          `✅ *Hotovo!*\n\n📝 ${popis}\n\n🚀 Změny jsou na GitHubu, Railway nasazuje...`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot.sendMessage(chatId,
          `⚠️ Nepodařilo se najít text k nahrazení v souboru.\n\nZkus být konkrétnější — napiš přesně který text nebo sekci chceš změnit.`
        );
      }
    } else {
      bot.sendMessage(chatId, responseText.substring(0, 4000));
    }

  } catch (err) {
    console.error(err);
    let errMsg = err.message || 'Neznámá chyba';
    if (err.status === 429) errMsg = 'Překročen limit Groq API. Zkus za chvíli.';
    if (err.status === 413) errMsg = 'Požadavek příliš velký.';
    if (err.status === 401) errMsg = 'Chybná autorizace — zkontroluj API klíče.';
    bot.sendMessage(chatId, `❌ Chyba: ${errMsg}`);
  }
});

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Agent server běží na portu ${PORT}`); });
