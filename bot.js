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

// ── CASTORUS — historique prix d'une annonce LBC ──────────────────────────────

async function getCastorusHistory(lbcId) {
    try {
        const url = `https://www.castorus.com/recherche/${lbcId}`;
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://www.castorus.com/',
            },
            timeout: 10000,
        });

        const $ = cheerio.load(res.data);

        const priceDropText = $('[class*="baisse"], [class*="drop"], [class*="price-history"]').length;

        let firstDate = null;
        $('time').each((i, el) => {
            const dt = $(el).attr('datetime');
            if (dt && !firstDate) firstDate = dt;
        });

        return { firstDate, priceDropsCastorus: priceDropText };
    } catch (e) {
        return null;
    }
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

            const pubDateRaw = ad.first_publication_date || ad.index_date || null;
            const firstSeen = pubDateRaw ? new Date(pubDateRaw).toISOString() : new Date().toISOString();
            const daysOnline = pubDateRaw
                ? Math.floor((Date.now() - new Date(pubDateRaw).getTime()) / 86400000)
                : 0;

            results.push({
                source: 'leboncoin',
                external_id: `lbc_${ad.list_id}`,
                lbc_id: String(ad.list_id),
                title: ad.subject || '',
                price,
                surface: parseInt(surface) || 0,
                rooms: parseInt(rooms) || 0,
                commune,
                url: `https://www.leboncoin.fr/ventes_immobilieres/${ad.list_id}.htm`,
                photo_count: ad.images?.nb_images || 0,
                description: ad.body || '',
                is_particulier: isParticulier,
                first_seen: firstSeen,
                last_seen: new Date().toISOString(),
                days_online: daysOnline,
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

            const dateAttr = $el.find('time').attr('datetime') || null;
            const firstSeen = dateAttr ? new Date(dateAttr).toISOString() : new Date().toISOString();
            const daysOnline = dateAttr
                ? Math.floor((Date.now() - new Date(dateAttr).getTime()) / 86400000)
                : 0;

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
                first_seen: firstSeen,
                last_seen: new Date().toISOString(),
                days_online: daysOnline,
            });
        });
    } catch (e) {
        console.log(`  ⚠️ PAP ${commune}: ${e.message.slice(0, 60)}`);
    }
    return results;
}

// ── SCRAPER SELOGER ───────────────────────────────────────────────────────────

async function scrapeSeLoger(commune) {
    const results = [];
    try {
        const communeMap = {
            'antibes': '6004',
            'juan-les-pins': '6004',
            'golfe-juan': '6155'
        };
        const codeInsee = communeMap[commune] || '6004';

        // SeLoger API JSON non-officielle via leur endpoint de recherche
        const url = `https://www.seloger.com/list.htm?idtypebien=1,2,3&idtt=2&naturebien=1,2,4&ci=${codeInsee}&LISTING-LISTpg=1`;
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'fr-FR,fr;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': 'https://www.seloger.com/',
            },
            timeout: 15000,
        });

        const $ = cheerio.load(res.data);

        // SeLoger injecte les données dans un script JSON
        let jsonData = null;
        $('script').each((i, el) => {
            const txt = $(el).html() || '';
            if (txt.includes('"classified"') || txt.includes('"listings"')) {
                try {
                    const match = txt.match(/window\.__REDIAL_PROPS__\s*=\s*(\[.*?\]);/s) ||
                                  txt.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*?\});/s);
                    if (match) jsonData = JSON.parse(match[1]);
                } catch (_) {}
            }
        });

        if (jsonData) {
            // Cherche les annonces dans la structure JSON SeLoger
            const listings = findListings(jsonData);
            for (const item of listings.slice(0, 40)) {
                const price = item.pricing?.price || item.price || 0;
                const surface = item.surface || item.livingArea || 0;
                const rooms = item.roomsQuantity || item.rooms || 0;
                const id = item.id || item.classifiedId || `${Date.now()}`;
                const title = item.title || item.publicationTitle || `${rooms} pièces ${surface}m²`;
                const desc = item.description || '';
                const photoCount = (item.photos || item.medias || []).length;
                const pubDate = item.publicationDate || item.firstPublicationDate || null;
                const firstSeen = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();
                const daysOnline = pubDate
                    ? Math.floor((Date.now() - new Date(pubDate).getTime()) / 86400000)
                    : 0;

                if (!price) continue;

                results.push({
                    source: 'seloger',
                    external_id: `sl_${id}`,
                    title,
                    price,
                    surface: parseFloat(surface) || 0,
                    rooms: parseInt(rooms) || 0,
                    commune,
                    url: item.classifiedURL || item.url || `https://www.seloger.com/annonces/achat/${id}.htm`,
                    photo_count: photoCount,
                    description: desc,
                    is_particulier: false,
                    first_seen: firstSeen,
                    last_seen: new Date().toISOString(),
                    days_online: daysOnline,
                });
            }
        } else {
            // Fallback: scraping HTML classique
            $('[data-testid="sl.list-item"], .c-pa-list .c-pa-info, article[data-listing-id]').each((i, el) => {
                if (i >= 40) return false;
                const $el = $(el);
                const id = $el.attr('data-listing-id') || $el.attr('data-id') || `${Date.now()}_${i}`;
                const priceStr = $el.find('[data-testid="price"], .c-pa-price').text().replace(/\D/g, '');
                const price = parseInt(priceStr) || 0;
                const title = $el.find('[data-testid="title"], .c-pa-title, h2').first().text().trim();
                const href = $el.find('a').first().attr('href') || '';
                const desc = $el.find('[data-testid="description"], .c-pa-desc').text().trim();
                const photoCount = $el.find('img').length;

                if (!price) return;

                results.push({
                    source: 'seloger',
                    external_id: `sl_${id}`,
                    title: title || `Annonce SeLoger`,
                    price,
                    surface: 0,
                    rooms: 0,
                    commune,
                    url: href.startsWith('http') ? href : `https://www.seloger.com${href}`,
                    photo_count: photoCount,
                    description: desc,
                    is_particulier: false,
                    first_seen: new Date().toISOString(),
                    last_seen: new Date().toISOString(),
                    days_online: 0,
                });
            });
        }
    } catch (e) {
        console.log(`  ⚠️ SeLoger ${commune}: ${e.message.slice(0, 60)}`);
    }
    return results;
}

function findListings(obj, depth = 0) {
    if (depth > 8 || !obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj)) {
        if (obj.length > 0 && obj[0]?.price !== undefined && obj[0]?.id !== undefined) return obj;
        for (const item of obj) {
            const found = findListings(item, depth + 1);
            if (found.length > 0) return found;
        }
    } else {
        for (const key of ['listings', 'classified', 'results', 'items', 'ads', 'properties']) {
            if (obj[key] && Array.isArray(obj[key]) && obj[key].length > 0) return obj[key];
        }
        for (const val of Object.values(obj)) {
            const found = findListings(val, depth + 1);
            if (found.length > 0) return found;
        }
    }
    return [];
}

// ── DÉTECTION MULTI-AGENCES (même bien sur plusieurs sources) ─────────────────

async function detectAgencyCount(annonce, allAnnonces) {
    const similar = allAnnonces.filter(a =>
        a.external_id !== annonce.external_id &&
        a.commune === annonce.commune &&
        a.surface > 0 && annonce.surface > 0 &&
        Math.abs(a.surface - annonce.surface) <= 5 &&
        a.rooms === annonce.rooms &&
        Math.abs(a.price - annonce.price) / annonce.price < 0.05
    );
    return 1 + similar.length;
}

// ── UPSERT EN BASE ────────────────────────────────────────────────────────────

async function upsertAnnonce(annonce, allAnnonces) {
    const { data: existing } = await supabase
        .from('annonces')
        .select('id, price, price_drops, first_seen, score, days_online')
        .eq('external_id', annonce.external_id)
        .single();

    const agencyCount = await detectAgencyCount(annonce, allAnnonces);

    if (existing) {
        const priceDrops = (existing.price_drops || 0) + (annonce.price < existing.price ? 1 : 0);

        const firstSeen = annonce.days_online > 0 ? annonce.first_seen : existing.first_seen;
        const daysOnline = annonce.days_online > 0
            ? annonce.days_online
            : Math.floor((Date.now() - new Date(existing.first_seen).getTime()) / 86400000);

        const updated = {
            ...annonce,
            price_drops: priceDrops,
            days_online: daysOnline,
            first_seen: firstSeen,
            agency_count: agencyCount,
        };
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
        let castorusData = null;
        if (annonce.lbc_id && annonce.days_online === 0) {
            castorusData = await getCastorusHistory(annonce.lbc_id);
            if (castorusData?.firstDate) {
                const castDays = Math.floor((Date.now() - new Date(castorusData.firstDate).getTime()) / 86400000);
                if (castDays > 0) {
                    annonce.days_online = castDays;
                    annonce.first_seen = new Date(castorusData.firstDate).toISOString();
                    console.log(`  📅 Castorus: ${annonce.external_id} en ligne depuis ${castDays}j`);
                }
            }
        }

        const full = { ...annonce, price_drops: 0, agency_count: agencyCount };
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
    const typeLabel = type === 'baisse_prix' ? '💸 BAISSE DE PRIX'
        : type === 'nouveau_seuil' ? '📈 SCORE EN HAUSSE'
        : '🆕 NOUVELLE ANNONCE';

    const daysStr = annonce.days_online > 0 ? ` · ${annonce.days_online}j en ligne` : '';

    const msg =
        `${emoji} ${typeLabel} — Score: ${annonce.score}/100\n` +
        `🏠 ${annonce.title}\n` +
        `💶 ${annonce.price?.toLocaleString('fr-FR')} €${daysStr}\n` +
        `📍 ${annonce.commune} (${annonce.source})\n` +
        `📊 ${annonce.score_details || 'aucun signal'}\n` +
        `🔗 ${annonce.url}`;

    try {
        await bot.sendMessage(CHAT_ID, msg);
    } catch (e) {
        console.log(`  ⚠️ Telegram: ${e.message.slice(0, 60)}`);
    }
}

// ── RECAP QUOTIDIEN ───────────────────────────────────────────────────────────

async function sendDailyRecap() {
    console.log(`\n[${new Date().toISOString()}] 📋 Recap quotidien...`);
    try {
        const { data: annonces } = await supabase
            .from('annonces')
            .select('*')
            .gte('score', SCORE_ALERT_THRESHOLD)
            .order('score', { ascending: false })
            .limit(15);

        if (!annonces || annonces.length === 0) {
            await bot.sendMessage(CHAT_ID, '📋 Recap quotidien : aucune annonce avec score ≥ 60 en base.');
            return;
        }

        // Séparation : candidats "changer d'agence" vs "particuliers à mandater"
        const multiAgence = annonces.filter(a => (a.agency_count || 1) >= 2 && !a.is_particulier);
        const particuliers = annonces.filter(a => a.is_particulier);
        const autres = annonces.filter(a => (a.agency_count || 1) < 2 && !a.is_particulier);

        let msg = `📋 RECAP QUOTIDIEN — ${new Date().toLocaleDateString('fr-FR')}\n`;
        msg += `━━━━━━━━━━━━━━━━━━━━━━\n`;
        msg += `${annonces.length} annonce(s) avec score ≥ 60\n\n`;

        if (multiAgence.length > 0) {
            msg += `🔄 SUSCEPTIBLES DE CHANGER D'AGENCE (${multiAgence.length})\n`;
            for (const a of multiAgence.slice(0, 5)) {
                const daysStr = a.days_online > 0 ? ` · ${a.days_online}j` : '';
                msg += `• ${a.score}/100 — ${a.title?.slice(0, 40)}\n`;
                msg += `  ${a.price?.toLocaleString('fr-FR')} € · ${a.commune}${daysStr}\n`;
                msg += `  ${a.score_details || ''}\n`;
                msg += `  ${a.url}\n\n`;
            }
        }

        if (particuliers.length > 0) {
            msg += `👤 PARTICULIERS À CONTACTER (${particuliers.length})\n`;
            for (const a of particuliers.slice(0, 5)) {
                const daysStr = a.days_online > 0 ? ` · ${a.days_online}j` : '';
                msg += `• ${a.score}/100 — ${a.title?.slice(0, 40)}\n`;
                msg += `  ${a.price?.toLocaleString('fr-FR')} € · ${a.commune}${daysStr}\n`;
                msg += `  ${a.score_details || ''}\n`;
                msg += `  ${a.url}\n\n`;
            }
        }

        if (autres.length > 0 && multiAgence.length + particuliers.length < 8) {
            msg += `📌 AUTRES SIGNAUX FORTS (${autres.length})\n`;
            for (const a of autres.slice(0, 3)) {
                const daysStr = a.days_online > 0 ? ` · ${a.days_online}j` : '';
                msg += `• ${a.score}/100 — ${a.title?.slice(0, 40)}\n`;
                msg += `  ${a.price?.toLocaleString('fr-FR')} € · ${a.commune}${daysStr}\n`;
                msg += `  ${a.url}\n\n`;
            }
        }

        // Telegram limite à ~4096 chars
        const chunks = splitMessage(msg, 4000);
        for (const chunk of chunks) {
            await bot.sendMessage(CHAT_ID, chunk);
            await new Promise(r => setTimeout(r, 500));
        }

        console.log(`  ✅ Recap envoyé: ${annonces.length} annonces`);
    } catch (e) {
        console.log(`  ⚠️ Recap: ${e.message.slice(0, 80)}`);
    }
}

function splitMessage(text, maxLen) {
    const chunks = [];
    while (text.length > maxLen) {
        let cut = text.lastIndexOf('\n\n', maxLen);
        if (cut < maxLen / 2) cut = maxLen;
        chunks.push(text.slice(0, cut));
        text = text.slice(cut).trimStart();
    }
    if (text) chunks.push(text);
    return chunks;
}

// ── SCAN PRINCIPAL ────────────────────────────────────────────────────────────

async function scan() {
    console.log(`\n[${new Date().toISOString()}] 🔍 Scan immobilier...`);
    let total = 0;
    const allAnnonces = [];

    for (const commune of COMMUNES) {
        await new Promise(r => setTimeout(r, 2000));
        const [lbc, pap, sl] = await Promise.all([
            scrapeLeboncoin(commune),
            scrapePAP(commune),
            scrapeSeLoger(commune),
        ]);
        const all = [...lbc, ...pap, ...sl];
        console.log(`  ${commune}: ${lbc.length} LBC + ${pap.length} PAP + ${sl.length} SeLoger = ${all.length} annonces`);
        allAnnonces.push(...all);
    }

    for (const annonce of allAnnonces) {
        await new Promise(r => setTimeout(r, 300));
        try {
            await upsertAnnonce(annonce, allAnnonces);
            total++;
        } catch (e) {
            console.log(`  ⚠️ ${annonce.external_id}: ${e.message.slice(0, 60)}`);
        }
    }

    console.log(`  ✅ ${total} annonces traitées`);
}

// ── DÉMARRAGE ─────────────────────────────────────────────────────────────────

async function main() {
    console.log('🏠 Bot veille immobilière — Antibes / Juan-les-Pins / Golfe-Juan');
    await scan();
    cron.schedule('0 */2 * * *', () => scan().catch(e => console.log('Scan error:', e.message)));
    cron.schedule('0 8 * * *', () => sendDailyRecap().catch(e => console.log('Recap error:', e.message)));
    console.log('⏰ Scan toutes les 2h · Recap quotidien à 8h');
}

main().catch(console.error);
