const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk').default;

const app = express();
app.use(express.json());

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: { interval: 2000, autoStart: true, params: { timeout: 10 } }
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

function applyPatch(original, patch) {
  const m = patch.match(/NAJDI:\n([\s\S]*?)\nNAHRAD:\n([\s\S]*?)(\nKONEC|$)/);
  if (!m) return null;
  const find = m[1].trim();
  const replace = m[2].trim();
  if (!original.includes(find)) return null;
  return original.replace(find, replace);
}

async function callClaude(systemPrompt, history) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 16000,
    system: systemPrompt,
    messages: history
  });
  return response.content[0].text;
}

async function processEdit(chatId, p, fileContent, fileSha, userRequest, retryContext = '') {
  const systemPrompt = `Jsi AI agent spravující web ${p.name} (${p.url}). Pracuješ se souborem ${p.file}.

PRAVIDLA:
- Měň POUZE to co uživatel žádá, nic jiného
- Vždy vrať přesný patch ve formátu níže
- Text v NAJDI musí být PŘESNÁ kopie z originálního souboru včetně mezer a odsazení
- Pokud je změna komplexní, rozděl ji na více NAJDI/NAHRAD bloků za sebou
- NIKDY nevracej celý soubor, pouze změny

${retryContext ? `PŘEDCHOZÍ POKUS SELHAL: ${retryContext}\nZkus najít přesnější text.` : ''}

Pro úpravy vrať PŘESNĚ:

POPIS: [stručný popis změny]
NAJDI:
[přesný text z originálního souboru]
NAHRAD:
[nový text]
KONEC

Pro více změn najednou:
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

Pro otázky nebo informace odpověz normálně BEZ formátu NAJDI/NAHRAD.
Odpovídej česky.

AKTUÁLNÍ OBSAH SOUBORU ${p.file}:
${fileContent}`;

  const history = [{ role: 'user', content: userRequest }];
  return await callClaude(systemPrompt, history);
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

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;

  const currentProject = projectState[chatId] || 'algorterma';
  const p = projects[currentProject];
  if (!conversationHistory[chatId]) conversationHistory[chatId] = [];

  if (text === '/start' || text === '/help') {
    bot.sendMessage(chatId,
      '👋 Jsem tvůj AI agent s Claude!\n\n' +
      '📁 *Projekty:*\n' +
      '/algorterma — AlgorTerma\n' +
      '/neumimplavat — Neumimplavat\n' +
      '/projekt — aktuální projekt\n\n' +
      '🕐 *Historie:*\n' +
      '/history — posledních 5 commitů\n' +
      '/revert abc123 — vrátit soubor na commit\n\n' +
      'Prostě mi napiš co chceš upravit!',
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
      bot.sendMessage(chatId, `🕐 *Historie: ${p.file}*\n\n${list}\n\nPro vrácení: /revert [hash]`, { parse_mode: 'Markdown' });
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

  bot.sendMessage(chatId, `⏳ Pracuji na tom... (${p.name})`);

  try {
    const { content: fileContent, sha: fileSha } = await getFile(p.repo, p.file);

    // První pokus
    let responseText = await processEdit(chatId, p, fileContent, fileSha, text);

    if (responseText.includes('NAJDI:') && responseText.includes('NAHRAD:')) {
      const { result, appliedCount, failedPatches } = applyAllPatches(fileContent, responseText);
      const popisMatch = responseText.match(/POPIS: (.+)/);
      const popis = popisMatch ? popisMatch[1] : 'Úprava webu';

      if (appliedCount > 0) {
        await updateFile(p.repo, p.file, result, fileSha, popis);
        const msg = failedPatches.length > 0
          ? `✅ *Hotovo!*\n\n📝 ${popis}\n⚠️ ${failedPatches.length} změn se nepodařilo aplikovat\n\n🚀 Na GitHubu, Railway nasazuje...`
          : `✅ *Hotovo!*\n\n📝 ${popis}\n\n🚀 Na GitHubu, Railway nasazuje...`;
        bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
      } else {
        // Retry — patch selhal, zkusíme znovu s kontextem
        bot.sendMessage(chatId, '🔄 Upřesňuji vyhledávání...');
        responseText = await processEdit(chatId, p, fileContent, fileSha, text, 'Text k nahrazení nebyl nalezen v souboru. Použij kratší a přesnější úsek textu.');

        if (responseText.includes('NAJDI:') && responseText.includes('NAHRAD:')) {
          const retry = applyAllPatches(fileContent, responseText);
          if (retry.appliedCount > 0) {
            const popis2 = responseText.match(/POPIS: (.+)/)?.[1] || 'Úprava webu';
            await updateFile(p.repo, p.file, retry.result, fileSha, popis2);
            bot.sendMessage(chatId, `✅ *Hotovo!*\n\n📝 ${popis2}\n\n🚀 Na GitHubu, Railway nasazuje...`, { parse_mode: 'Markdown' });
          } else {
            bot.sendMessage(chatId, '⚠️ Nepodařilo se aplikovat změny. Zkus být konkrétnější — napiš přesně který element nebo text chceš změnit.');
          }
        } else {
          bot.sendMessage(chatId, responseText.substring(0, 4000));
        }
      }
    } else {
      bot.sendMessage(chatId, responseText.substring(0, 4000));
    }

  } catch (err) {
    console.error(err);
    let errMsg = err.message || 'Neznámá chyba';
    if (err.status === 429) errMsg = 'Překročen limit API. Zkus za chvíli.';
    if (err.status === 401) errMsg = 'Chybný API klíč — zkontroluj ANTHROPIC_API_KEY v Railway.';
    bot.sendMessage(chatId, `❌ Chyba: ${errMsg}`);
  }
});

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Agent server běží na portu ${PORT}`); });
