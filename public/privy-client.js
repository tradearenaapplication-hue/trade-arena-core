/**
 * Privy Embedded Wallet Integration
 * Replaces MetaMask with no-seed-phrase wallet
 * 
 * Setup:
 * 1. Sign up at https://privy.io
 * 2. Create project, get App ID
 * 3. Configure embedded wallet for Base only
 */

var PRIVY_CONFIG = {
    // Privy App ID from dashboard.privy.com
    appId: 'cmpl1hc0k00ui0djsr3qo8gg8', // Fallback
    // JWKS URL for token verification
    jwksUrl: 'https://auth.privy.io/api/v1/apps/cmpl1hc0k00ui0djsr3qo8gg8/jwks.json',
    // Base mainnet ONLY - NO network dropdown
    chain: 'base',
    chainId: '0x2105',
    chainName: 'Base',
    // USDC only - hide all other tokens
    defaultToken: 'USDC',
    // Fiat display
    fiatCurrency: 'USD',
    // Hide blockchain complexity from user
    hideBlockchain: true,
};

// 🛡️ DYNAMIC CONFIG: Load Privy Client ID from backend (/api/config allowlist).
// Accepts both `privyClientId` (current) and `privyAppId` (legacy alias) so the
// stale bundle keeps working until it is rebuilt from the root privy-client.js.
(async function() {
    try {
        const response = await fetch('/api/config', { cache: 'no-store' });
        const config = await response.json();
        const clientId = config.privyClientId || config.privyAppId;
        if (clientId) {
            PRIVY_CONFIG.appId = clientId;
            PRIVY_CONFIG.jwksUrl = `https://auth.privy.io/api/v1/apps/${clientId}/jwks.json`;
            console.log('[Config] Privy Client ID updated from backend');
        } else {
            console.warn('[Config] Privy Client ID missing from /api/config — social login disabled');
        }
    } catch (e) {
        console.warn('[Config] Failed to load dynamic Privy config');
    }
})();

// Privy state
if (typeof window.privyUser === 'undefined') window.privyUser = null;
if (typeof window.privyWalletAddress === 'undefined') window.privyWalletAddress = null;
if (typeof window.privyConnected === 'undefined') window.privyConnected = false;

var privyUser = window.privyUser;
var privyWalletAddress = window.privyWalletAddress;
var privyConnected = window.privyConnected;

/**
 * Initialize Privy embedded wallet
 * Call this on app startup
 */
async function privyInit() {
    console.log('[Privy] Initializing...');
    
    //动态加载 Privy SDK
    if (!window.Privy) {
        await loadPrivyScript();
    }
    
    if (!window.Privy) {
        console.warn('[Privy] SDK not loaded - using fallback mode');
        return false;
    }
    
    try {
        // Configure Privy
        window.Privy.configure({
            appId: PRIVY_CONFIG.appId,
        });
        
        // Check for existing session
        const user = window.Privy.getUser();
        if (user) {
            const walletAddr = user.wallet?.address;
            const preferredAddress = '0x92CEAf1CA43deCfc443A34B915B45343BeE9c2DB';
            
            // 🛡️ PRIORITY LOCK: If MetaMask is already connected or this is the wrong address, 
            // do not auto-login to the embedded wallet.
            if (window.walletState && window.walletState.walletType === 'metamask') {
                console.log('[Privy] Skipping auto-login - MetaMask is already active.');
                return true;
            }
            
            if (walletAddr && walletAddr.toLowerCase() !== preferredAddress.toLowerCase()) {
                console.log('[Privy] Embedded wallet detected, but MetaMask is preferred. Standing by.');
            }

            privyUser = user;
            privyWalletAddress = walletAddr;
            privyConnected = true;
            console.log('[Privy] Restored session:', privyWalletAddress);
            onPrivyLoginSuccess();
        }
        
        return true;
    } catch (e) {
        console.error('[Privy] Init error:', e);
        return false;
    }
}

/**
 * Load Privy SDK script dynamically
 */
async function loadPrivyScript() {
    return new Promise((resolve) => {
        if (window.Privy) {
            resolve();
            return;
        }
        
        const script = document.createElement('script');
        script.src = 'https://cdn.privy.io/widget.js';
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => {
            console.warn('[Privy] Failed to load SDK');
            resolve();
        };
        document.head.appendChild(script);
    });
}

/**
 * Handle Google sign-in via Privy (stale public copy).
 *
 * This file is superseded by the root privy-client.js. It stays only so the
 * stale public/index.html bundle keeps loading, but it must never fabricate
 * a session — delegate to the root client when present, otherwise fail loudly.
 */
async function privyLoginGoogle() {
    console.log('[Privy] Opening Google OAuth (stale public copy — delegating)...');
    // This stale copy loads BEFORE the root client in some bundles. The root
    // client overwrites window.privyLoginGoogle on load, so by the time a user
    // clicks, this function may already be shadowed. If we are still the live
    // handler, the root client is absent — fail loudly, never fake a session.
    console.error('[Privy] Stale bundle: SDK unavailable — use MetaMask or Demo mode.');
    if (window.showToast) window.showToast('Google sign-in unavailable. Use MetaMask or Demo mode.', 'error');
    const s = document.getElementById('loginStatus');
    if (s) s.textContent = '⚠️ Google sign-in unavailable — use MetaMask or Demo mode.';
    return false;
}

/**
 * Fallback REMOVED (Google): the stale public copy previously fell through to
 * a mock login. Now fails loudly. Stub kept for lingering references.
 */
async function privyFallbackGoogleLogin() {
    console.error('[Privy] Fallback login removed — social login requires the real Privy SDK.');
    if (window.showToast) window.showToast('Google sign-in unavailable. Use MetaMask or Demo mode.', 'error');
    return false;
}

/**
 * Handle Apple sign-in via Privy (stale public copy — same fail-loud policy).
 */
async function privyLoginApple() {
    console.log('[Privy] Opening Apple OAuth (stale public copy)...');
    console.error('[Privy] Stale bundle: SDK unavailable — use MetaMask or Demo mode.');
    if (window.showToast) window.showToast('Apple sign-in unavailable. Use MetaMask or Demo mode.', 'error');
    const s = document.getElementById('loginStatus');
    if (s) s.textContent = '⚠️ Apple sign-in unavailable — use MetaMask or Demo mode.';
    return false;
}

/**
 * Fallback REMOVED (Apple): previously minted a random address. Stub kept so
 * old references fail loudly instead of throwing ReferenceError.
 */
async function privyFallbackAppleLogin() {
    console.error('[Privy] Fallback login removed — social login requires the real Privy SDK.');
    if (window.showToast) window.showToast('Apple sign-in unavailable. Use MetaMask or Demo mode.', 'error');
    return false;
}

/**
 * REMOVED: generateRandomAddress fabricated wallet addresses. Stub throws
 * loudly so any lingering caller cannot silently mint an address.
 */
function generateRandomAddress() {
    throw new Error('generateRandomAddress removed: fake wallets are disabled for fund safety.');
}

/**
 * UI Helpers
 */
function hideConnectScreen() {
    const cs = document.getElementById('connectScreen');
    if (cs) cs.style.display = 'none';
}

function showConnectScreen() {
    const cs = document.getElementById('connectScreen');
    if (cs) cs.style.display = 'flex';
}

function showMainApp() {
    const app = document.getElementById('mainApp');
    if (app) {
        app.style.display = 'flex';
        app.style.flexDirection = 'column';
    }
}

function hideMainApp() {
    const app = document.getElementById('mainApp');
    if (app) app.style.display = 'none';
}

/**
 * Called when Privy login succeeds
 */
function onPrivyLoginSuccess() {
    console.log('[Privy] Login success! Wallet:', privyWalletAddress);
    hideConnectScreen();
    showMainApp();
    
    // Update UI with wallet info
    updateWalletUI();
    
    // Notify app ready
    if (typeof window.onPrivyReady === 'function') {
        window.onPrivyReady(privyUser, privyWalletAddress);
    }
}

/**
 * Update wallet-related UI elements
 */
function updateWalletUI() {
    const balanceEl = document.getElementById('ghBalance') || document.getElementById('walletBalance');
    if (balanceEl) {
        // Show USD balance instead of ETH
        if (window.walletState && window.walletState.balanceUSD) {
            balanceEl.textContent = '$' + window.walletState.balanceUSD.toFixed(2);
        } else if (window.getWalletBalanceUSD) { 
            window.getWalletBalanceUSD().then(bal => { balanceEl.textContent = '$' + bal.toFixed(2); }); 
        } else { 
            balanceEl.textContent = '$0.00'; 
        }
    }
    
    const userAddrEl = document.getElementById('userAddr');
    if (userAddrEl && privyWalletAddress) {
        userAddrEl.textContent = privyWalletAddress.substring(0, 6) + '...' + privyWalletAddress.substring(38);
    }
    
    const networkBadge = document.getElementById('ghNetwork');
    if (networkBadge) {
        networkBadge.style.display = 'inline'; // Show "BASE" badge
        networkBadge.textContent = 'BASE';
    }
}

/**
 * Get user's wallet address
 */
function getPrivyAddress() {
    return privyWalletAddress;
}

/**
 * Check if connected
 */
function isPrivyConnected() {
    return privyConnected && !!privyWalletAddress;
}

/**
 * Sign a message with the Privy embedded wallet (stale public copy).
 *
 * Fund-safety: never return a simulated signature. The old code returned the
 * literal string '0xsignature...' which would fail verification while looking
 * like success. Now throws instead.
 */
async function privySignMessage(message) {
    if (!privyConnected || !privyWalletAddress) {
        throw new Error('Privy wallet is not connected');
    }
    throw new Error('Privy SDK is not available in this stale bundle; cannot sign — use the root privy-client.js flow');
}

/**
 * Disconnect wallet (stale public copy) — also clears persisted session keys
 * so a reload cannot restore a session the user explicitly ended.
 */
function privyDisconnect() {
    console.log('[Privy] Disconnecting...');
    privyUser = null;
    privyWalletAddress = null;
    privyConnected = false;

    try {
        localStorage.removeItem('ta_wallet_address');
        localStorage.removeItem('ta_provider');
        localStorage.removeItem('ta_session_provider');
    } catch (e) { /* storage unavailable */ }

    if (window.Privy && typeof window.Privy.logout === 'function') {
        try { window.Privy.logout(); } catch (e) { console.warn('[Privy] Logout error:', e.message); }
    }

    showConnectScreen();
    hideMainApp();
}

function privyLogin() {
    console.log('[Privy] Login requested');
    if (window.Privy && typeof window.Privy.login === 'function') {
        try {
            window.Privy.login();
            return;
        } catch (e) {
            console.warn('[Privy] Widget login error, falling back:', e);
        }
    }
    privyLoginGoogle();
}
window.privyLogin = privyLogin;

// Export functions
window.privyInit = privyInit;
window.privyLoginGoogle = privyLoginGoogle;
window.privyLoginApple = privyLoginApple;
window.getPrivyAddress = getPrivyAddress;
window.isPrivyConnected = isPrivyConnected;
window.privySignMessage = privySignMessage;
window.privyDisconnect = privyDisconnect;

async function handlePrivyClick() {
    console.log('[Privy] Handle click triggered');
    const status = document.getElementById('loginStatus');
    if (status) status.textContent = 'Initializing Secure Login...';
    
    try {
        await privyInit();
        if (window.privyLogin) {
            window.privyLogin();
        } else {
            // Fallback if React bridge hasn't taken over yet
            privyLoginGoogle();
        }
    } catch (e) {
        console.error('[Privy] Click handler error:', e);
        if (status) status.textContent = 'Error: ' + e.message;
        privyLoginGoogle(); // Extreme fallback
    }
}
window.handlePrivyClick = handlePrivyClick;
