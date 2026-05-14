require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const COMMUNES = ['antibes', 'juan-les-pins', 'golfe-juan'];
const SCORE_ALERT_THRESHOLD = 60;

// ── SCORING ───────────────────────────────────────────────────────────────────

function scoreAnnonce(annonce) {
    let score = 0;
    const details = [];

    const daysOnline = annonce.days_online || 0;
    if (daysOnline > 180) { score += 30; details.push(`${daysOnline}j en ligne`); }
    else if (daysOnline > 90) { score += 20; details.push(`${daysOnline}j en ligne`); }
    else if (daysOnline > 30) { score += 10; details.push(`${daysOnline}j en ligne`); }

    const priceDrops = annonce.price_drops || 0;
    if (priceDrops >= 2) { score += 25; details.push(`${priceDrops} baisses de prix`); }
    else if (priceDrops === 1) { score += 10; details.push(`1 baisse de prix`); }

    const agencyCount = annonce.agency_count || 1;
    if (agencyCount >= 3) { score += 20; details.push(`${agencyCount} agences`); }
    else if (agencyCount === 2) { score += 10; details.push(`2 agences`); }

    if (annonce.is_particulier) { score += 25; details.push('particulier'); }

    const desc = (annonce.description || '').toLowerCase();
    const urgencyWords = ['urgent', 'mutation', 'succession', 'divorce', 'départ', 'liquidation'];
    const found = urgencyWords.filter(w => desc.includes(w));
    if (found.length > 0) { score += 20; details.push(found.join(', ')); }

    const title = (annonce.title || '').toLowerCase();
    const foundTitle = urgencyWords.filter(w => title.includes(w));
    if (foundTitle.length > 0 && found.length === 0) { score += 20; details.push(foundTitle.join(', ')); }

    if ((annonce.photo_count || 0) < 5) { score += 10; details.push('peu de photos'); }
    if ((annonce.description || '').length < 150) { score += 10; details.push('description courte'); }

    return { score: Math.min(score, 100), details };
}

// ── SCRAPER LEBONCOIN ─────────────────────────────────────────────────────────

async function scrapeLeboncoin(commune) {
    const results = [];
    try {
        const url = `https://www.leboncoin.fr/recherche?category=9&locations=${encodeURIComponent(commune + ',06')}&real_estate_type=1,2,3`;
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 15000,
        });

        const $ = cheerio.load(res.data);
        const scriptData = $('script#__NEXT_DATA__').text();
        if (!scriptData) return results;

        const json = JSON.parse(scriptData);
        const ads = json?.props?.pageProps?.searchData?.ads || [];

        for (const ad of ads.slice(0, 50)) {
            const price = ad.price?.[0] || 0;
            const surface = ad.attributes?.find(a => a.key === 'square')?.value_label || '';
            const rooms = ad.attributes?.find(a => a.key === 'rooms')?.value_label || '';
            const isParticulier = !ad.owner?.store_id;

            results.push({
                source: 'leboncoin',
                external_id: `lbc_${ad.list_id}`,
                title: ad.subject || '',
                price,
                surface: parseInt(surface) || 0,
                rooms: parseInt(rooms) || 0,
                commune,
                url: `https://www.leboncoin.fr/ventes_immobilieres/${ad.list_id}.htm`,
                photo_count: ad.images?.nb_images || 0,
                description: ad.body || '',
                is_particulier: isParticulier,
                first_seen: new Date().toISOString(),
                last_seen: new Date().toISOString(),
            });
        }
    } catch (e) {
        console.log(`  ⚠️ Leboncoin ${commune}: ${e.message.slice(0, 60)}`);
    }
    return results;
}

// ── SCRAPER PAP ───────────────────────────────────────────────────────────────

async function scrapePAP(commune) {
    const results = [];
    try {
        const communeMap = {
            'antibes': 'antibes-06600',
            'juan-les-pins': 'antibes-06160',
            'golfe-juan': 'vallauris-06220'
        };
        const slug = communeMap[commune] || commune;
        const url = `https://www.pap.fr/annonce/ventes-immobilieres-${slug}`;

        const res = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
            timeout: 15000,
        });

        const $ = cheerio.load(res.data);

        $('article.search-list-item').each((i, el) => {
            if (i >= 30) return false;
            const $el = $(el);
            const title = $el.find('h2').text().trim();
            const priceStr = $el.find('.price').text().replace(/\D/g, '');
            const price = parseInt(priceStr) || 0;
            const href = $el.find('a').attr('href') || '';
            const id = href.split('/').pop()?.split('-')[0] || `${Date.now()}_${i}`;
            const desc = $el.find('.description').text().trim();
            const photoCount = $el.find('img').length;

            if (!title || !price) return;

            results.push({
                source: 'pap',
                external_id: `pap_${id}`,
                title,
                price,
                surface: 0,
                rooms: 0,
                commune,
                url: href.startsWith('http') ? href : `https://www.pap.fr${href}`,
                photo_count: photoCount,
                description: desc,
                is_particulier: true,
                first_seen: new Date().toISOString(),
                last_seen: new Date().toISOString(),
            });
        });
    } catch (e) {
        console.log(`  ⚠️ PAP ${commune}: ${e.message.slice(0, 60)}`);
    }
    return results;
}

// ── UPSERT EN BASE ────────────────────────────────────────────────────────────

async function upsertAnnonce(annonce) {
    const { data: existing } = await supabase
        .from('annonces')
        .select('id, price, price_drops, first_seen, score')
        .eq('external_id', annonce.external_id)
        .single();

    if (existing) {
        const priceDrops = (existing.price_drops || 0) + (annonce.price < existing.price ? 1 : 0);
        const daysOnline = Math.floor((Date.now() - new Date(existing.first_seen).getTime()) / 86400000);
        const updated = { ...annonce, price_drops: priceDrops, days_online: daysOnline, first_seen: existing.first_seen };
        const { score, details } = scoreAnnonce(updated);
        updated.score = score;
        updated.score_details = details.join(' · ');

        await supabase.from('annonces').update(updated).eq('id', existing.id);

        if (score >= SCORE_ALERT_THRESHOLD && (existing.score || 0) < SCORE_ALERT_THRESHOLD) {
            await sendAlert(updated, 'nouveau_seuil');
        }
        if (annonce.price < existing.price) {
            await sendAlert(updated, 'baisse_prix');
        }
    } else {
        const full = { ...annonce, price_drops: 0, days_online: 0 };
        const { score, details } = scoreAnnonce(full);
        full.score = score;
        full.score_details = details.join(' · ');
        await supabase.from('annonces').insert(full);
        if (score >= SCORE_ALERT_THRESHOLD) {
            await sendAlert(full, 'nouvelle');
        }
    }
}

// ── ALERTES TELEGRAM ──────────────────────────────────────────────────────────

async function sendAlert(annonce, type) {
    const emoji = annonce.score >= 80 ? '🔴' : '🟡';
    const typeLabel = type === 'baisse_prix' ? '💸 BAISSE DE PRIX' : type === 'nouveau_seuil' ? '📈 SCORE EN HAUSSE' : '🆕 NOUVELLE ANNONCE';

    const msg =
        `${emoji} ${typeLabel} — Score: ${annonce.score}/100\n` +
        `🏠 ${annonce.title}\n` +
        `💶 ${annonce.price?.toLocaleString('fr-FR')} €\n` +
        `📍 ${annonce.commune} (${annonce.source})\n` +
        `📊 ${annonce.score_details || 'aucun signal'}\n` +
        `🔗 ${annonce.url}`;

    try {
        await bot.sendMessage(CHAT_ID, msg);
    } catch (e) {
        console.log(`  ⚠️ Telegram: ${e.message.slice(0, 60)}`);
    }
}

// ── SCAN PRINCIPAL ────────────────────────────────────────────────────────────

async function scan() {
    console.log(`\n[${new Date().toISOString()}] 🔍 Scan immobilier...`);
    let total = 0;

    for (const commune of COMMUNES) {
        await new Promise(r => setTimeout(r, 2000));
        const [lbc, pap] = await Promise.all([scrapeLeboncoin(commune), scrapePAP(commune)]);
        const all = [...lbc, ...pap];
        console.log(`  ${commune}: ${lbc.length} LBC + ${pap.length} PAP = ${all.length} annonces`);

        for (const annonce of all) {
            await new Promise(r => setTimeout(r, 300));
            try { await upsertAnnonce(annonce); total++; }
            catch (e) { console.log(`  ⚠️ ${annonce.external_id}: ${e.message.slice(0, 60)}`); }
        }
    }
    console.log(`  ✅ ${total} annonces traitées`);
}

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────

async function main() {
    console.log('🏠 Bot veille immobilière — Antibes / Juan-les-Pins / Golfe-Juan');
    await scan();
    cron.schedule('0 */2 * * *', () => scan().catch(e => console.log('Scan error:', e.message)));
    console.log('⏰ Scan toutes les 2h');
}

main().catch(console.error);
