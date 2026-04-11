const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const WALLET = process.env.WALLET;
const ALERT_THRESHOLD = 5;

let lastAlertPnl = null;

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

async function getPortfolio() {
    try {
        const res = await axios.get(
            `https://dlmm.datapi.meteora.ag/portfolio/open?user=${WALLET}`
        );

        const pools = res.data.pools || [];

        if (pools.length === 0) {
            console.log("Aucune position ouverte sur Météora.");
            return null;
        }

        const total = res.data.total;
        const balances = parseFloat(total.balances);
        const pnl = parseFloat(total.pnl);
        const fees = parseFloat(total.unclaimedFees);
        const deposit = pools.reduce((sum, p) => sum + parseFloat(p.totalDeposit), 0);

        return { balances, pnl, fees, deposit, pools };
    } catch (err) {
        if (err.response && err.response.status === 400) {
            console.log("Aucune position ouverte sur Météora.");
            return null;
        }
        throw err;
    }
}

async function check() {
    try {
        const data = await getPortfolio();
        if (!data) return;

        const pnl = data.pnl;
        const poolNames = data.pools.map(p => p.tokenX + "/" + p.tokenY).join(", ");

        console.log("💰 Valeur: $" + data.balances.toFixed(2) + " | Dépôt initial: $" + data.deposit.toFixed(2) + " | PnL: $" + pnl.toFixed(2) + " | Fees: $" + data.fees.toFixed(2) + " | Pools: " + poolNames);

        if (pnl >= ALERT_THRESHOLD) {
            if (lastAlertPnl === null || pnl >= lastAlertPnl + ALERT_THRESHOLD) {
                bot.sendMessage(CHAT_ID,
                    "🚨 SORTIR DE POSITION ?\n\n" +
                    "💰 Valeur: $" + data.balances.toFixed(2) + "\n" +
                    "📥 Dépôt initial: $" + data.deposit.toFixed(2) + "\n" +
                    "📈 PnL: +$" + pnl.toFixed(2) + "\n" +
                    "💸 Fees: $" + data.fees.toFixed(2) + "\n" +
                    "🏊 Pools: " + poolNames + "\n\n" +
                    "Tu es en positif de +$" + pnl.toFixed(2) + " !"
                );
                lastAlertPnl = pnl;
                console.log("📨 Alerte envoyée !");
            }
        } else if (pnl < 0) {
            lastAlertPnl = null;
        }

    } catch (err) {
        console.log("Erreur:", err.message);
    }
}

setInterval(check, 30000);
check();
