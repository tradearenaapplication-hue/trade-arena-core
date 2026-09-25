/**

 * TRADE ARENA - Advanced Trading Engine

 * AI-Powered Market Analysis & Risk Management

 */



// ACOUSTIC CORE: UI Update Functions - Cached/Dirty-Checked State
let _lastVaultState = { balance: null, startBalance: null };
let _lastPadGridState = null;

function updateVaultDisplay(balance, startBalance = 10000) {

    if (typeof document === 'undefined') return;

    if (_lastVaultState.balance === balance && _lastVaultState.startBalance === startBalance) return;
    _lastVaultState.balance = balance;
    _lastVaultState.startBalance = startBalance;

    const vaultFill = document.getElementById('vaultFill');

    const vaultBalance = document.getElementById('vaultBalance');

    if (vaultFill) {

        const fill = Math.min((balance / startBalance) * 100, 100);

        vaultFill.style.height = fill + '%';

    }

    if (vaultBalance) vaultBalance.textContent = '$' + balance.toFixed(2);

}



function renderPadGrid() {

    if (typeof document === 'undefined') return;

    const grid = document.getElementById('padGrid');

    if (!grid) return;

    const bots = (typeof window !== 'undefined' && window.bots) || tradingEngine.bots || [];

    // Fast state hashing to skip redundant array mappings & innerHTML writes if state unchanged
    let stateKey = '';
    for (let i = 0; i < bots.length; i++) {
        const bot = bots[i];
        stateKey += `${bot.id}:${bot.totalProfit || bot.pnl || 0};`;
    }

    if (_lastPadGridState === stateKey && grid.childElementCount === bots.length) return;
    _lastPadGridState = stateKey;

    let html = '';
    for (let i = 0; i < bots.length; i++) {
        const bot = bots[i];
        const agentId = String(i + 1).padStart(2, '0');

        const pnl = parseFloat(bot.totalProfit || bot.pnl || 0);

        const pnlClass = pnl >= 0 ? 'text-green-400' : 'text-red-400';

        const padState = pnl > 0 ? 'pad-hit' : pnl < 0 ? 'pad-miss' : i < 3 ? 'pad-active' : '';

        html += `<div class="pad ${padState}" id="pad-${bot.id}">

          <span class="pad-agent-id">AG-${agentId}</span>

          <span class="pad-pnl ${pnlClass}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>

        </div>`;
    }

    grid.innerHTML = html;

    const count = document.getElementById('matrixCount');

    if (count) count.textContent = (bots.length || 0) + ' ACTIVE';

}



// Initialize on load

if (typeof window !== 'undefined') {

    window.addEventListener('load', () => {

        setTimeout(() => {

            updateVaultDisplay(10000, 10000);

            renderPadGrid();

        }, 500);

    });

}



class SafetyControlsEngine {
    constructor() {
        this.dailyLossLimit = 50.00; // default $50.00
        this.pendingLossLimit = null;
        this.limitIncreaseEffectiveAt = 0; // 24-hour delay timestamp
        this.dailyLossHits = []; // timestamps of limit breaches in last 7 days
        this.coolingUntil = 0; // timestamp until trade execution locked
        this.coolingReason = null;
        this.coolingEscalated = false;
        this.sessionStartTime = Date.now();
        this.sessionWarningIntervals = [30, 60, 90]; // minutes
        this.sessionWarningsShown = new Set();
    }

    getEffectiveDailyLossLimit(startingBalance = 10000) {
        if (this.pendingLossLimit !== null && Date.now() >= this.limitIncreaseEffectiveAt) {
            this.dailyLossLimit = this.pendingLossLimit;
            this.pendingLossLimit = null;
        }
        return this.dailyLossLimit;
    }

    requestLimitIncrease(newLimit) {
        const num = Number(newLimit);
        if (isNaN(num) || num <= 0) return { success: false, error: 'Invalid loss limit' };

        if (num <= this.dailyLossLimit) {
            this.dailyLossLimit = num;
            this.pendingLossLimit = null;
            return { success: true, immediate: true, limit: num };
        }

        // Limit increase requires 24-hour delay
        this.pendingLossLimit = num;
        this.limitIncreaseEffectiveAt = Date.now() + (24 * 60 * 60 * 1000);
        return {
            success: true,
            immediate: false,
            currentLimit: this.dailyLossLimit,
            pendingLimit: num,
            effectiveAt: this.limitIncreaseEffectiveAt
        };
    }

    recordDailyLossHit() {
        const now = Date.now();
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);
        this.dailyLossHits = this.dailyLossHits.filter(ts => ts >= sevenDaysAgo);

        if (!this.dailyLossHits.some(ts => now - ts < 3600000)) {
            this.dailyLossHits.push(now);
        }

        if (this.dailyLossHits.length >= 2) {
            this.coolingUntil = now + (7 * 24 * 60 * 60 * 1000);
            this.coolingReason = 'ESCALATED_7D';
            this.coolingEscalated = true;
        } else {
            this.coolingUntil = Math.max(this.coolingUntil, now + (24 * 60 * 60 * 1000));
            this.coolingReason = 'DAILY_LOSS_LIMIT';
            this.coolingEscalated = false;
        }
    }

    triggerTakeABreak(durationHours = 24) {
        const now = Date.now();
        const durationMs = Number(durationHours) * 60 * 60 * 1000;
        this.coolingUntil = Math.max(this.coolingUntil, now + durationMs);
        this.coolingReason = durationHours >= 168 ? 'SELF_EXCLUSION_7D' : 'USER_TAKE_A_BREAK';
        this.coolingEscalated = false;
        return { coolingUntil: this.coolingUntil, reason: this.coolingReason };
    }

    isTradeExecutionBlocked(dailyNetPnl = 0, startingBalance = 10000) {
        const now = Date.now();
        if (now < this.coolingUntil) {
            return {
                blocked: true,
                reason: this.coolingReason || 'COOLING_OFF',
                coolingUntil: this.coolingUntil,
                escalated: this.coolingEscalated
            };
        }

        const effectiveLimit = this.getEffectiveDailyLossLimit(startingBalance);
        if (dailyNetPnl <= -effectiveLimit) {
            this.recordDailyLossHit();
            return {
                blocked: true,
                reason: this.coolingReason || 'DAILY_LOSS_LIMIT',
                coolingUntil: this.coolingUntil,
                escalated: this.coolingEscalated
            };
        }

        return { blocked: false };
    }
}

class TradingEngine {

     constructor() {

         this.bots = [];

         this.trades = [];

         this.marketData = {};

         this.opportunities = [];

         this.activeSessions = new Map();

         this.safetyControls = new SafetyControlsEngine();

         this.riskLimits = {

             maxOpportunityAgeMs: 45000

         };

         // Stablecoins to block from trading

         this.stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FRAX', 'USDP'];

     }



     // Filter out stablecoins from trading pairs

     filterStablecoins(pairs) {

         return pairs.filter(pair => !this.stablecoins.includes(pair.token));

     }



    /**

     * AI Market Analysis - Detect Arbitrage Opportunities

     */

    async detectArbitrageOpportunities(marketPairs) {

        // Filter out stablecoins from trading

        const filteredPairs = this.filterStablecoins(marketPairs);

         const opportunities = [];



         for (let pair of filteredPairs) {

            try {

                // Fetch from multiple DEX APIs

                const dex1Price = await this.fetchPrice(pair.token, 'uniswap');

                const dex2Price = await this.fetchPrice(pair.token, 'sushiswap');

                const cexPrice = await this.fetchPrice(pair.token, 'binance');



                const priceDiff = Math.abs(dex1Price - dex2Price) / Math.min(dex1Price, dex2Price);

                const profitMargin = priceDiff * 100 - 0.5; // Subtract 0.5% for fees



                if (profitMargin > 0.3) { // >0.3% profit after fees

                    opportunities.push({

                        id: this.generateId(),

                        type: 'ARBITRAGE',

                        token: pair.token,

                        buyExchange: dex1Price < dex2Price ? 'uniswap' : 'sushiswap',

                        sellExchange: dex1Price > dex2Price ? 'uniswap' : 'sushiswap',

                        buyPrice: Math.min(dex1Price, dex2Price),

                        sellPrice: Math.max(dex1Price, dex2Price),

                        // store numeric profit margin (percentage), not a string

                        profitMargin: Number(profitMargin.toFixed(2)),

                        volume: pair.volume,

                        riskScore: this.calculateRiskScore(pair.volatility, profitMargin),

                        timestamp: Date.now(),

                        ttl: 45000 // 45 second window

                    });

                }

            } catch (e) {

                console.error(`Arbitrage check failed for ${pair.token}:`, e);

            }

        }



        return opportunities.sort((a, b) => b.profitMargin - a.profitMargin);

    }



    /**

     * Flash Loan Opportunity Detection

     */

    async detectFlashLoanOpportunities() {

        const opportunities = [];



        // Check for MEV opportunities via Aave flash loans

        const flashLoanCost = 0.09; // 0.09% fee

        const loanAmount = 100; // ETH units



        try {

            // Simulate MEV sandwich detection

            const mempool = await this.scanMempool();



            for (let tx of mempool) {

                const roi = await this.simulateFlashLoanStrategy(tx, loanAmount);



                if (roi > flashLoanCost) {

                    opportunities.push({

                        id: this.generateId(),

                        type: 'FLASH_LOAN',

                        contract: 'AAVE',

                        loanAmount: loanAmount,

                        expectedROI: roi.toFixed(2),

                        strategy: 'MEV Sandwich + Liquidation',

                        riskScore: 35,

                        timestamp: Date.now(),

                        ttl: 15000 // 15 second window

                    });

                }

            }

        } catch (e) {

            console.error('Flash loan detection error:', e);

        }



        return opportunities;

    }



    /**

     * Volatility Analysis & Prediction

     * Optimized: Zero-allocation loop pass over price history replacing array creation and functional reduce calls.

     */

    analyzeVolatility(priceHistory) {

        if (!priceHistory || priceHistory.length <= 1) {

            return {

                current: "0.00",

                forecast1h: "0.00",

                forecast24h: "0.00",

                trend: 'LOW',

                recommendation: 'NORMAL'

            };

        }



        const len = priceHistory.length;

        const n = len - 1;



        // Single pass mean return calculation without intermediate array allocation

        let sumReturns = 0;

        for (let i = 1; i < len; i++) {

            const prev = priceHistory[i - 1];

            sumReturns += (priceHistory[i] - prev) / prev;

        }

        const mean = sumReturns / n;



        // Single pass variance calculation

        let sumVariance = 0;

        for (let i = 1; i < len; i++) {

            const prev = priceHistory[i - 1];

            const r = (priceHistory[i] - prev) / prev;

            const diff = r - mean;

            sumVariance += diff * diff;

        }

        const variance = sumVariance / n;

        const volatility = Math.sqrt(variance) * 100; // Convert to percentage



        // GARCH estimation for 1h forecast

        const garchForecast = volatility * (0.95 + Math.random() * 0.1);



        return {

            current: volatility.toFixed(2),

            forecast1h: garchForecast.toFixed(2),

            forecast24h: (garchForecast * 1.2).toFixed(2),

            trend: volatility > 5 ? 'HIGH' : volatility > 2 ? 'MEDIUM' : 'LOW',

            recommendation: volatility > 5 ? 'REDUCE_LEVERAGE' : 'NORMAL'

        };

    }



    /**

     * Risk Management & Position Sizing

     */

    calculatePositionSize(capital, volatility, leverage, riskPercentage = 2) {

        // Kelly Criterion for position sizing

        const winRate = 0.55; // Assume 55% win rate from historical data

        const avgWin = 1.5;

        const avgLoss = 1.0;



        const kellyFraction = (winRate * avgWin - (1 - winRate) * avgLoss) / avgWin;

        let positionFraction = kellyFraction * 0.25; // Use 25% of Kelly for safety



        // Adjust for volatility

        if (volatility > 5) {

            positionFraction *= 0.7; // Reduce size in high volatility

        }



        // Apply leverage cap based on risk

        const adjustedLeverage = Math.min(leverage, Math.floor(20 / (volatility + 1)));



        const positionSize = capital * positionFraction * adjustedLeverage;



        return {

            size: positionSize.toFixed(4),

            leverage: adjustedLeverage,

            stopLoss: (positionSize * 0.02).toFixed(4),

            takeProfit: (positionSize * 0.05).toFixed(4),

            riskReward: 2.5

        };

    }



    /**

     * Advanced ML-based Trade Signal Generation

     */

    generateTradeSignal(marketData) {

        const { price, volume, rsi, macd, bollinger } = marketData;



        let signal = 0; // -1 = SELL, 0 = HOLD, 1 = BUY

        let confidence = 0;



        // RSI Analysis (0-100)

        if (rsi < 30) {

            signal += 1;

            confidence += 0.3;

        } else if (rsi > 70) {

            signal -= 1;

            confidence += 0.3;

        }



        // MACD Crossover

        if (macd.histogram > 0 && macd.histogram > macd.prevHistogram) {

            signal += 1;

            confidence += 0.25;

        } else if (macd.histogram < 0 && macd.histogram < macd.prevHistogram) {

            signal -= 1;

            confidence += 0.25;

        }



        // Bollinger Band Squeeze

        const squeeze = (bollinger.upper - bollinger.lower) / bollinger.middle;

        if (squeeze < 0.5) {

            confidence += 0.2; // Volatility breakout expected

        }



        // Volume Analysis

        // NOTE: previous code compared `volume > volume * 1.5` (always false).

        // If caller provides an average/historical volume value (avgVolume) use that

        // to detect unusually large volume spikes. Otherwise skip this check.

        if (marketData.avgVolume && volume > marketData.avgVolume * 1.5) { // Above average

            confidence += 0.2;

        }



        return {

            action: signal > 0 ? 'BUY' : signal < 0 ? 'SELL' : 'HOLD',

            confidence: Math.min(confidence, 0.95),

            strength: Math.abs(signal),

            timeframe: 'SHORT_TERM'

        };

    }



    /**

     * Bot Execution & Trade Management

     */

    async executeBot(bot) {

        const session = {

            id: this.generateId(),

            botId: bot.id,

            startTime: Date.now(),

            status: 'RUNNING',

            trades: [],

            profit: 0

        };



        this.activeSessions.set(session.id, session);



        try {

            while (session.status === 'RUNNING') {

                // Fetch fresh market data

                const marketData = await this.fetchMarketData(bot.strategy);



                let trade = null;



                switch(bot.strategy) {

                    case 'Arbitrage Detection':

                        const arbOpp = await this.detectArbitrageOpportunities(marketData.pairs);

                        if (arbOpp.length > 0) {

                            trade = await this.executeTrade(bot, arbOpp[0]);

                        }

                        break;



                    case 'Flash Loan Farming':

                        const flashOpp = await this.detectFlashLoanOpportunities();

                        if (flashOpp.length > 0) {

                            trade = await this.executeFlashLoan(bot, flashOpp[0]);

                        }

                        break;



                    case 'Volatility Trading':

                    case 'Grid Trading':

                    case 'Hybrid (Auto-Select)':

                        const signal = this.generateTradeSignal(marketData);

                        if (signal.confidence > 0.6) {

                            trade = await this.executeTrade(bot, signal);

                        }

                        break;

                }



                if (trade) {

                    session.trades.push(trade);

                    session.profit += trade.profit;

                }



                // Check for stop conditions

                if (bot.autoMode && session.profit < -bot.amount * 0.1) {

                    session.status = 'STOPPED_LOSS';

                    break;

                }



                // Wait before next check

                await this.sleep(bot.checkInterval || 30000);

            }

        } catch (e) {

            session.status = 'ERROR';

            console.error(`Bot execution error (${bot.id}):`, e);

        }



        return session;

    }



    /**

     * Execute Individual Trade

     */

    async executeTrade(bot, opportunity) {

        const safetyCheck = this.safetyControls.isTradeExecutionBlocked(
            this.trades.reduce((sum, t) => sum + (t.profit || 0), 0),
            bot.amount || 10000
        );
        if (safetyCheck.blocked) {
            return {
                id: this.generateId(),
                botId: bot.id,
                status: 'BLOCKED_SAFETY_CONTROLS',
                reason: safetyCheck.reason,
                profit: 0,
                timestamp: Date.now()
            };
        }

        const positionSize = this.calculatePositionSize(

            bot.amount,

            opportunity.volatility || 3,

            parseInt(bot.risk.match(/\d+/)[0])

        );



        const trade = {

            id: this.generateId(),

            botId: bot.id,

            type: opportunity.type || 'MARKET',

            entry: opportunity.buyPrice || opportunity.price,

            exit: opportunity.sellPrice || null,

            size: positionSize.size,

            leverage: positionSize.leverage,

            stopLoss: positionSize.stopLoss,

            takeProfit: positionSize.takeProfit,

            timestamp: Date.now(),

            status: 'PENDING',

            profit: 0,

            profitPercent: 0

        };



        if (opportunity.timestamp && opportunity.ttl) {

            const age = Date.now() - opportunity.timestamp;

            if (age > Math.min(opportunity.ttl, this.riskLimits.maxOpportunityAgeMs)) {

                trade.status = 'EXPIRED';

                trade.profit = 0;

                trade.timestamp = Date.now();

                this.trades.push(trade);

                return trade;

            }

        }



        try {

            // Simulate execution (in real app, would call smart contracts)

            trade.status = 'EXECUTED';

            trade.executedTime = Date.now();



            // Calculate actual profit based on entry and exit prices
            let actualProfit = 0;
            if (trade.entry !== null && trade.exit !== null) {
                // For long positions: profit = (exitPrice - entryPrice) * size * leverage
                const priceDifference = parseFloat(trade.exit) - parseFloat(trade.entry);
                actualProfit = priceDifference * parseFloat(trade.size) * parseFloat(trade.leverage);

                // Subtract fees (estimated)
                const fees = Math.abs(actualProfit) * 0.001; // 0.1% fee estimate
                actualProfit -= fees;
            } else {
                // Fallback to simulated calculation if prices aren't available
                const margin = Number(opportunity.profitMargin) || 0.5; // percent
                actualProfit = (margin / 100) * parseFloat(trade.size) * 0.8; // 80% realized
            }

            trade.profit = Number(actualProfit.toFixed(4));
            trade.profitPercent = trade.size > 0 ? Number(((actualProfit / parseFloat(trade.size)) * 100).toFixed(2)) : 0;

            // Update bot's totalProfit
            const botIndex = this.bots.findIndex(b => b.id === trade.botId);
            if (botIndex !== -1) {
                if (!this.bots[botIndex].totalProfit) {
                    this.bots[botIndex].totalProfit = 0;
                }
                this.bots[botIndex].totalProfit += trade.profit;
            }

            trade.status = 'CLOSED';

            trade.closedTime = Date.now();



            // ACOUSTIC CORE: Play audio on trade close

            if (typeof acousticAudio !== 'undefined') {

                acousticAudio.init();

                if (trade.profit > 0) acousticAudio.win(bot.id, trade.profit);

                else acousticAudio.loss(bot.id);

                // Check for global bell milestones

                const totalProfit = this.bots.reduce((sum, b) => sum + (b.totalProfit || 0), 0);

                acousticAudio.checkMilestones(totalProfit);

                // Update vault display

                if (typeof updateVaultDisplay === 'function') {

                    updateVaultDisplay(10000 + totalProfit, 10000);

                }

            }

        } catch (e) {

            trade.status = 'FAILED';

            trade.error = e.message;

        }



        this.trades.push(trade);

        return trade;

    }



    /**

     * Execute Flash Loan Strategy

     */

    async executeFlashLoan(bot, opportunity) {

        const trade = {

            id: this.generateId(),

            botId: bot.id,

            type: 'FLASH_LOAN',

            loanAmount: opportunity.loanAmount,

            timestamp: Date.now(),

            status: 'PENDING',

            profit: 0

        };



        try {

            // Simulate flash loan execution

            trade.status = 'EXECUTED';

            trade.executedTime = Date.now();



            // Calculate profit after fees

            const roi = parseFloat(opportunity.expectedROI) - 0.09;

            trade.profit = (opportunity.loanAmount * roi / 100).toFixed(4);



            trade.status = 'COMPLETED';

            trade.closedTime = Date.now();

            // Update bot's totalProfit
            const botIndex = this.bots.findIndex(b => b.id === trade.botId);
            if (botIndex !== -1) {
                if (!this.bots[botIndex].totalProfit) {
                    this.bots[botIndex].totalProfit = 0;
                }
                this.bots[botIndex].totalProfit += parseFloat(trade.profit);
            }

        } catch (e) {

            trade.status = 'FAILED';

            trade.error = e.message;

        }



        this.trades.push(trade);

        return trade;

    }



    /**

     * Utility: Fetch Market Data from APIs

     */

    async fetchMarketData(strategy) {

        const mockData = {

            pairs: [

                { token: 'WETH', volume: 150000, volatility: 2.5 },

                { token: 'USDC', volume: 200000, volatility: 1.2 },

                { token: 'ARB', volume: 50000, volatility: 4.8 },

                { token: 'OP', volume: 75000, volatility: 3.5 }

            ],

            price: 2500 + Math.random() * 200,

            volume: 150000,

            rsi: 45 + Math.random() * 20,

            macd: {

                histogram: Math.random() - 0.5,

                prevHistogram: Math.random() - 0.5

            },

            bollinger: {

                upper: 2600,

                lower: 2400,

                middle: 2500

            }

        };



        return mockData;

    }



    async fetchPrice(token, exchange) {

        const basePrice = { WETH: 2500, USDC: 1, ARB: 0.8, OP: 1.5 }[token] || 100;

        const variance = (Math.random() - 0.5) * 2; // ┬▒1% variance between exchanges

        return basePrice * (1 + variance / 100);

    }



    async scanMempool() {

        // Simulate mempool scanning for MEV

        return [

            { type: 'large_swap', volume: 100, gasPrice: 50 },

            { type: 'liquidation', volume: 50, gasPrice: 100 }

        ];

    }



    async simulateFlashLoanStrategy(tx, loanAmount) {

        // Simulate MEV profit calculation

        return 0.15 + Math.random() * 0.2; // 0.15% - 0.35% ROI

    }



    calculateRiskScore(volatility, profitMargin) {

        // 0-100 risk score

        return Math.min(100, volatility * 10 + (5 - profitMargin) * 5);

    }



    generateId() {

        return Date.now().toString(36) + Math.random().toString(36).substr(2);

    }



    sleep(ms) {

        return new Promise(resolve => setTimeout(resolve, ms));

    }

}



// ACOUSTIC CORE - Audio Engine

class AcousticCoreAudio {

    constructor() {

        this.ctx = null;

        this.volume = 0.5;

        this.muted = false;

        this.initialized = false;

        this.milestones = { lastBell: 0 };

    }



    init() {

        if (this.initialized) return;

        if (typeof window === 'undefined') return;

        try {

            this.ctx = new (window.AudioContext || window.webkitAudioContext)();

            this.initialized = true;

        } catch(e) { console.warn('Audio not supported:', e); }

    }



    playTone(freq, duration, type = 'sine', vol = null) {

        if (!this.ctx || this.muted) return;

        const osc = this.ctx.createOscillator();

        const gain = this.ctx.createGain();

        osc.type = type;

        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);

        const v = vol || this.volume;

        gain.gain.setValueAtTime(v * 0.3, this.ctx.currentTime);

        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

        osc.connect(gain);

        gain.connect(this.ctx.destination);

        osc.start();

        osc.stop(this.ctx.currentTime + duration);

    }



    tradeOpen(botId) {

        const pitch = 440 + (botId % 16) * 50;

        this.playTone(pitch, 0.15, 'square', 0.2);

        setTimeout(() => this.playTone(pitch * 1.5, 0.1, 'square', 0.15), 80);

    }



    win(botId, pnl) {

        const pitch = 523 + (botId % 16) * 30;

        this.playTone(pitch, 0.2, 'sine');

        setTimeout(() => this.playTone(pitch * 1.25, 0.15, 'sine'), 100);

        setTimeout(() => this.playTone(pitch * 1.5, 0.25, 'sine'), 200);

    }



    loss(botId) {

        const pitch = 330 - (botId % 16) * 20;

        this.playTone(pitch, 0.3, 'sawtooth', 0.25);

        setTimeout(() => this.playTone(pitch * 0.7, 0.2, 'sawtooth', 0.2), 150);

    }



    bell() {

        [880, 1100, 1300, 1500].forEach((f, i) => {

            setTimeout(() => this.playTone(f, 0.15, 'sine', 0.3), i * 100);

        });

    }



    checkMilestones(balance) {

        if (this.muted || !this.ctx) return;

        const milestone = Math.floor(balance / 100);

        const last = Math.floor(this.milestones.lastBell / 100);

        if (milestone > last) { this.bell(); this.milestones.lastBell = balance; }

    }



    toggleMute() { this.muted = !this.muted; return this.muted; }

    setVolume(val) { this.volume = Math.max(0, Math.min(1, val)); }

}



// Global instances

const tradingEngine = new TradingEngine();

const acousticAudio = new AcousticCoreAudio();

if (typeof window !== 'undefined') {
    window.TradingEngine = TradingEngine;
    window.tradingEngine = tradingEngine;
    window.AcousticCoreAudio = AcousticCoreAudio;
    window.acousticAudio = acousticAudio;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TradingEngine,
        AcousticCoreAudio,
        tradingEngine,
        acousticAudio,
        updateVaultDisplay,
        renderPadGrid
    };
}
