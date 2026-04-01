const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Client, GatewayIntentBits } = require('discord.js');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(express.json());

// ── Telegram ──
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: { interval: 2000, autoStart: true, params: { timeout: 10 } }
});

// ── Discord ──
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

const anthropic = new Anthropic({ apiKey: process.env.AI_AGENT_ANTHROPIC });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USER = 'jrslvlbnsk-droid';

const projects = {
  algorterma: { repo: 'algorterma-web', file: 'index.html', name: 'AlgorTerma', url: 'algorterma.cz' },
  neumimplavat: { repo: 'neumimplavat', file: 'index.html', name: 'Neumimplavat', url: 'neumimplavat.cz' }
};

const projectState = {};
const conversationHistory = {};

// ── GitHub helpers ──
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
  if (!res.ok) { const err = await res.json(); throw new Error(`GitHub chyba: ${err.message}`); }
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

// ── Claude ──
async function callClaude(systemPrompt, history) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    system: systemPrompt,
    messages: history
  });
  return response.content[0].text;
}

async function processEdit(p, fileContent, userRequest, retryContext = '') {
  const systemPrompt = `Jsi AI agent spravující web ${p.name} (${p.url}). Pracuješ se souborem ${p.file}.

PRAVIDLA:
- Měň POUZE to co uživatel žádá, nic jiného
- Text v NAJDI musí být PŘESNÁ kopie z originálního souboru včetně mezer a odsazení
- Pokud je změna komplexní, rozděl ji na více NAJDI/NAHRAD bloků
- NIKDY nevracej celý soubor, pouze změny

${retryContext ? `PŘEDCHOZÍ POKUS SELHAL: ${retryContext}\nZkus najít přesnější text.` : ''}

Pro úpravy vrať PŘESNĚ:

POPIS: [stručný popis změny]
NAJDI:
[přesný text z originálního souboru]
NAHRAD:
[nový text]
KONEC

Pro více změn:
POPIS: [popis]
NAJDI:
[první úsek]
NAHRAD:
[nová verze]
KONEC
NAJDI:
[druhý úsek]
NAHRAD:
[nová verze]
KONEC

Pro otázky odpověz normálně BEZ formátu NAJDI/NAHRAD.
Odpovídej česky.

AKTUÁLNÍ OBSAH SOUBORU ${p.file}:
${fileContent}`;

  return await callClaude(systemPrompt, [{ role: 'user', content: userRequest }]);
}

function applyAllPatches(original, responseText) {
  const patchRegex = /NAJDI:\n([\s\S]*?)\nNAHRAD:\n([\s\S]*?)\nKONEC/g;
  let result = original;
  let match;
  let appliedCount = 0;
  let failedPatches = [];

  while ((match = patchRegex.exec(responseText)) !== null) {
    const find = match[1].trim();
    const replace = match[2].trim();
    if (result.includes(find)) {
      result = result.replace(find, replace);
      appliedCount++;
    } else {
      failedPatches.push(find.substring(0, 50) + '...');
    }
  }

  return { result, appliedCount, failedPatches };
}

// ── Společná logika pro oba boty ──
async function handleMessage(chatId, text, sendFn) {
  const currentProject = projectState[chatId] || 'algorterma';
  const p = projects[currentProject];

  if (text === '/start' || text === '/help') {
    sendFn('👋 Jsem tvůj AI agent s Claude!\n\n' +
      '📁 Projekty:\n' +
      '/algorterma — AlgorTerma\n' +
      '/neumimplavat — Neumimplavat\n' +
      '/projekt — aktuální projekt\n\n' +
      '🕐 Historie:\n' +
      '/history — posledních 5 commitů\n' +
      '/revert abc123 — vrátit soubor na commit\n\n' +
      'Prostě mi napiš co chceš upravit!');
    return;
  }

  if (text === '/algorterma') {
    projectState[chatId] = 'algorterma';
    sendFn('✅ Přepnuto na AlgorTerma');
    return;
  }

  if (text === '/neumimplavat') {
    projectState[chatId] = 'neumimplavat';
    sendFn('✅ Přepnuto na Neumimplavat');
    return;
  }

  if (text === '/projekt') {
    sendFn(`📁 Projekt: ${p.name} (${p.url})\n📄 Soubor: ${p.file}`);
    return;
  }

  if (text === '/history') {
    try {
      sendFn('⏳ Načítám historii...');
      const commits = await getCommits(p.repo, p.file);
      const list = commits.map((c, i) =>
        `${i + 1}. ${c.sha.substring(0, 7)} — ${c.commit.message}\n    📅 ${new Date(c.commit.author.date).toLocaleString('cs-CZ')}`
      ).join('\n\n');
      sendFn(`🕐 Historie: ${p.file}\n\n${list}\n\nPro vrácení: /revert [hash]`);
    } catch (e) {
      sendFn(`❌ Chyba: ${e.message}`);
    }
    return;
  }

  if (text.startsWith('/revert ')) {
    const hash = text.replace('/revert ', '').trim();
    try {
      sendFn(`⏳ Vracím na verzi ${hash}...`);
      const oldContent = await getFileAtCommit(p.repo, p.file, hash);
      const current = await getFile(p.repo, p.file);
      await updateFile(p.repo, p.file, oldContent, current.sha, `Revert na ${hash}`);
      sendFn(`✅ Vráceno na verzi ${hash}`);
    } catch (e) {
      sendFn(`❌ Chyba při revertu: ${e.message}`);
    }
    return;
  }

  sendFn(`⏳ Pracuji na tom... (${p.name})`);

  try {
    const { content: fileContent, sha: fileSha } = await getFile(p.repo, p.file);

    let responseText = await processEdit(p, fileContent, text);

    if (responseText.includes('NAJDI:') && responseText.includes('NAHRAD:')) {
      const { result, appliedCount, failedPatches } = applyAllPatches(fileContent, responseText);
      const popis = responseText.match(/POPIS: (.+)/)?.[1] || 'Úprava webu';

      if (appliedCount > 0) {
        await updateFile(p.repo, p.file, result, fileSha, popis);
        const msg = failedPatches.length > 0
          ? `✅ Hotovo!\n\n📝 ${popis}\n⚠️ ${failedPatches.length} změn se nepodařilo aplikovat\n\n🚀 Na GitHubu, Railway nasazuje...`
          : `✅ Hotovo!\n\n📝 ${popis}\n\n🚀 Na GitHubu, Railway nasazuje...`;
        sendFn(msg);
      } else {
        sendFn('🔄 Upřesňuji vyhledávání...');
        responseText = await processEdit(p, fileContent, text, 'Text k nahrazení nebyl nalezen. Použij kratší a přesnější úsek textu.');

        if (responseText.includes('NAJDI:') && responseText.includes('NAHRAD:')) {
          const retry = applyAllPatches(fileContent, responseText);
          if (retry.appliedCount > 0) {
            const popis2 = responseText.match(/POPIS: (.+)/)?.[1] || 'Úprava webu';
            await updateFile(p.repo, p.file, retry.result, fileSha, popis2);
            sendFn(`✅ Hotovo!\n\n📝 ${popis2}\n\n🚀 Na GitHubu, Railway nasazuje...`);
          } else {
            sendFn('⚠️ Nepodařilo se aplikovat změny. Zkus být konkrétnější.');
          }
        } else {
          sendFn(responseText.substring(0, 2000));
        }
      }
    } else {
      sendFn(responseText.substring(0, 2000));
    }

  } catch (err) {
    console.error(err);
    let errMsg = err.message || 'Neznámá chyba';
    if (err.status === 429) errMsg = 'Překročen limit API. Zkus za chvíli.';
    if (err.status === 401) errMsg = 'Chybný API klíč.';
    sendFn(`❌ Chyba: ${errMsg}`);
  }
}

// ── Telegram handler ──
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;
  await handleMessage(String(chatId), text, (response) => {
    bot.sendMessage(chatId, response);
  });
});

// ── Discord handler ──
discord.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;
  const text = msg.content;
  if (!text.startsWith('/') && !msg.mentions.has(discord.user)) return;
  const cleanText = text.replace(`<@${discord.user?.id}>`, '').trim();
  if (!cleanText) return;

  await handleMessage(`discord_${msg.author.id}`, cleanText, (response) => {
    msg.reply(response);
  });
});

discord.once('ready', () => {
  console.log(`Discord bot přihlášen jako ${discord.user?.tag}`);
});

discord.login(process.env.AI_AGENT_DISCORD);

process.on('SIGTERM', () => { bot.stopPolling(); discord.destroy(); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Agent server běží na portu ${PORT}`); });
