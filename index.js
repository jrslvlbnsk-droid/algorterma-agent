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
const pendingChange = {};

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

async function callGroq(systemPrompt, history) {
  for (const limit of [20000, 12000, 6000]) {
    const truncated = systemPrompt.replace(/AKTUÁLNÍ OBSAH SOUBORU:\n[\s\S]*/,
      `AKTUÁLNÍ OBSAH SOUBORU:\n${systemPrompt.match(/AKTUÁLNÍ OBSAH SOUBORU:\n([\s\S]*)/)?.[1]?.substring(0, limit) || ''}`
    );
    try {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 8000,
        messages: [{ role: 'system', content: truncated }, ...history]
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

function simpleDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const removed = oldLines.filter(l => !newLines.includes(l)).length;
  const added = newLines.filter(l => !oldLines.includes(l)).length;
  return `➕ Přidáno řádků: ${added}\n➖ Odebráno řádků: ${removed}\n📄 Celkem řádků: ${newLines.length}`;
}

function wantsPreview(text) {
  const keywords = ['náhled', 'preview', 'ukaž', 'zobraz', 'zkontroluj před', 'před uložením'];
  return keywords.some(k => text.toLowerCase().includes(k));
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
      '📂 *Soubory:*\n' +
      '/soubor index.html — přepnout soubor\n' +
      '/soubory — seznam souborů v repozitáři\n\n' +
      '🕐 *Historie:*\n' +
      '/history — posledních 5 commitů\n' +
      '/revert abc123 — vrátit soubor na commit\n\n' +
      '✅ *Čekající změny:*\n' +
      '/potvrdit — uložit čekající změnu\n' +
      '/nahled — zobrazit náhled čekající změny\n' +
      '/zrusit — zrušit čekající změnu\n\n' +
      'Tip: Přidej "náhled" nebo "ukaž před uložením" do zprávy pro náhled změn.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (text === '/algorterma') {
    projectState[chatId] = 'algorterma';
    conversationHistory[chatId] = [];
    delete pendingChange[chatId];
    bot.sendMessage(chatId, '✅ Přepnuto na projekt *AlgorTerma*', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/neumimplavat') {
    projectState[chatId] = 'neumimplavat';
    conversationHistory[chatId] = [];
    delete pendingChange[chatId];
    bot.sendMessage(chatId, '✅ Přepnuto na projekt *Neumimplavat*', { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/projekt') {
    bot.sendMessage(chatId, `📁 Projekt: *${p.name}* (${p.url})\n📄 Soubor: \`${p.file}\``, { parse_mode: 'Markdown' });
    return;
  }

  if (text.startsWith('/soubor ')) {
    const filename = text.replace('/soubor ', '').trim();
    projects[currentProject].file = filename;
    bot.sendMessage(chatId, `📄 Soubor přepnut na: \`${filename}\``, { parse_mode: 'Markdown' });
    return;
  }

  if (text === '/soubory') {
    try {
      const url = `https://api.github.com/repos/${GITHUB_USER}/${p.repo}/contents/`;
      const res = await fetch(url, { headers: { Authorization: `token ${GITHUB_TOKEN}` } });
      const files = await res.json();
      const list = files.filter(f => f.type === 'file').map(f => `• \`${f.name}\``).join('\n');
      bot.sendMessage(chatId, `📂 Soubory v repozitáři *${p.name}*:\n${list}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Nelze načíst soubory: ${e.message}`);
    }
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
      bot.sendMessage(chatId, `❌ Chyba při načítání historie: ${e.message}`);
    }
    return;
  }

  if (text.startsWith('/revert ')) {
    const hash = text.replace('/revert ', '').trim();
    try {
      bot.sendMessage(chatId, `⏳ Načítám verzi \`${hash}\`...`, { parse_mode: 'Markdown' });
      const oldContent = await getFileAtCommit(p.repo, p.file, hash);
      const current = await getFile(p.repo, p.file);
      const diff = simpleDiff(current.content, oldContent);
      pendingChange[chatId] = { newContent: oldContent, sha: current.sha, popis: `Revert na ${hash}` };
      bot.sendMessage(chatId,
        `📋 *Náhled revertu na \`${hash}\`*\n\n${diff}\n\nPotvrdit? /potvrdit nebo /zrusit`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ Chyba při revertu: ${e.message}`);
    }
    return;
  }

  if (text === '/nahled') {
    const pending = pendingChange[chatId];
    if (!pending) {
      bot.sendMessage(chatId, '⚠️ Žádná čekající změna.');
      return;
    }
    try {
      const current = await getFile(p.repo, p.file);
      const diff = simpleDiff(current.content, pending.newContent);
      bot.sendMessage(chatId,
        `📋 *Náhled čekající změny:*\n\n📝 ${pending.popis}\n\n${diff}\n\n/potvrdit nebo /zrusit`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ Chyba: ${e.message}`);
    }
    return;
  }

  if (text === '/potvrdit') {
    const pending = pendingChange[chatId];
    if (!pending) {
      bot.sendMessage(chatId, '⚠️ Žádná čekající změna.');
      return;
    }
    try {
      await updateFile(p.repo, p.file, pending.newContent, pending.sha, pending.popis);
      delete pendingChange[chatId];
      bot.sendMessage(chatId,
        `✅ *Hotovo!*\n\n📝 ${pending.popis}\n\n🚀 Změny jsou na GitHubu, Railway nasazuje...`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(chatId, `❌ Chyba při ukládání: ${e.message}`);
    }
    return;
  }

  if (text === '/zrusit') {
    delete pendingChange[chatId];
    bot.sendMessage(chatId, '🚫 Změna zrušena.');
    return;
  }

  // ── AI požadavek ──

  bot.sendMessage(chatId, `⏳ Pracuji na tom... (${p.name})`);

  try {
    let fileContent = '';
    let fileSha = null;

    try {
      const fileData = await getFile(p.repo, p.file);
      fileContent = fileData.content;
      fileSha = fileData.sha;
    } catch (e) {
      bot.sendMessage(chatId, `⚠️ Nepodařilo se načíst soubor:\n${e.message}`);
      return;
    }

    const systemPrompt = `Jsi AI agent spravující web ${p.name} (${p.url}). Pracuješ se souborem ${p.file} v repozitáři ${p.repo}.

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

        if (wantsPreview(text)) {
          const diff = simpleDiff(fileContent, novyKod);
          pendingChange[chatId] = { newContent: novyKod, sha: fileSha, popis };
          bot.sendMessage(chatId,
            `📋 *Náhled změn:*\n\n📝 ${popis}\n\n${diff}\n\nUložit? /potvrdit nebo /zrusit`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await updateFile(p.repo, p.file, novyKod, fileSha, popis);
          bot.sendMessage(chatId,
            `✅ *Hotovo!*\n\n📝 ${popis}\n\n🚀 Změny jsou na GitHubu, Railway nasazuje...`,
            { parse_mode: 'Markdown' }
          );
        }
      } else {
        bot.sendMessage(chatId, '⚠️ Kód se nepodařilo extrahovat. Zkus přeformulovat požadavek.');
      }
    } else {
      bot.sendMessage(chatId, responseText.substring(0, 4000));
    }

  } catch (err) {
    console.error(err);
    let errMsg = err.message || 'Neznámá chyba';
    if (err.status === 429) errMsg = 'Překročen limit Groq API. Zkus za chvíli.';
    if (err.status === 413) errMsg = 'Soubor je příliš velký pro zpracování.';
    if (err.status === 401) errMsg = 'Chybná autorizace — zkontroluj API klíče.';
    bot.sendMessage(chatId, `❌ Chyba: ${errMsg}`);
  }
});

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => { console.log(`Agent server běží na portu ${PORT}`); });
