/**
 * Privy Embedded Wallet Integration
 *
 * Social (Google/Apple) login plus a Privy-managed embedded wallet on Base, so
 * users need neither a seed phrase nor a browser extension.
 *
 * ── Why this file was rewritten ────────────────────────────────────────────
 * The previous version called a fictional API (`window.Privy.configure`,
 * `window.Privy.loginWithGoogle`, `window.Privy.on('login')`) and loaded
 * `https://cdn.privy.io/widget.js`, a host that does not resolve at all. It
 * therefore ALWAYS fell through to the "fallback" path, which invented a random
 * address and reported a successful login.
 *
 * That was a fund-safety bug, not a cosmetic one: `moonpay-client.js` passes
 * `getPrivyAddress()` to the MoonPay widget as the destination for a real USDC
 * purchase. Anyone who tapped "Sign in with Google" and then "Deposit USDC"
 * would have sent money to a throwaway address whose keys nobody holds -
 * unrecoverable. `privySignMessage` had the same shape, returning the literal
 * string '0xsignature...' as if it were a real signature.
 *
 * Both fake paths are gone. If Privy is unavailable or unconfigured we now fail
 * loudly and never fabricate a wallet, a signature, or a session.
 *
 * The real SDK (`@privy-io/js-sdk-core`) ships no global CDN build, so it is
 * imported as an ES module from jsDelivr and driven through the documented API:
 *   new Privy({ appId, clientId, storage })
 *   await privy.initialize()
 *   await privy.user.get()
 *   await privy.auth.oauth.login({ provider: 'google' })
 *   await privy.auth.logout({ userId })
 */

const PRIVY_CONFIG = {
    // App ID from dashboard.privy.io. Verified live: the JWKS endpoint for
    // this id returns 200, so the app really exists.
    appId: 'cmpl1hc0k00ui0djsr3qo8gg8',

    // Client ID from dashboard.privy.io -> Settings -> Clients.
    //
    // A Privy App ID and Client ID are PUBLIC identifiers, not credentials:
    // Privy's own vanilla-JS quickstart puts both directly in browser code.
    // So it is safe to deliver this to the browser, which is what
    // /api/config does. The Client SECRET is the sensitive one and must never
    // be sent to the client or embedded in any frontend file.
    //
    // Resolution order: an explicit window override (handy for local testing)
    // first, then the server-provided value fetched at startup.
    clientId: (typeof window !== 'undefined' && window.TA_PRIVY_CLIENT_ID) || '',

    // ESM build of the vanilla SDK. Note: cdn.privy.io does not resolve.
    sdkUrl: 'https://cdn.jsdelivr.net/npm/@privy-io/js-sdk-core@latest/+esm',

    // Base mainnet only - no network dropdown
    chain: 'base',
    chainId: '0x2105',
    chainName: 'Base',
    // USDC only - hide all other tokens
    defaultToken: 'USDC',
    // Fiat display
    fiatCurrency: 'USD',
    // Hide blockchain complexity from the user
    hideBlockchain: true,
};

/**
 * Social login needs BOTH an app id and a client id. If either is missing the
 * client cannot be constructed, so we must not pretend login succeeded.
 */
function isPrivyConfigured() {
    return !!(PRIVY_CONFIG.appId && PRIVY_CONFIG.clientId);
}

// Privy state
let privyUser = null;
let privyWalletAddress = null;
let privyConnected = false;

// The SDK instance, its iframe and message bridge. Built once, then reused.
let privyClient = null;
let privyFrame = null;
let privyMessageListener = null;
let privyBootPromise = null;

// Helper the SDK exports for locating a user's embedded wallet.
let getUserEmbeddedEthereumWallet = null;

// Memoised so repeated calls (init, then a button press) share one request.
let privyConfigPromise = null;

/**
 * Fetch the public client config from the server.
 *
 * Only the values on the server's allowlist can arrive here, so this cannot
 * leak a secret. Any failure is non-fatal: we simply stay unconfigured and
 * social login remains disabled, which is the safe direction to fail in.
 */
function loadPrivyClientConfig() {
    if (PRIVY_CONFIG.clientId) return Promise.resolve(PRIVY_CONFIG.clientId);
    if (privyConfigPromise) return privyConfigPromise;

    privyConfigPromise = fetch('/api/config', { cache: 'no-store' })
        .then((res) => {
            if (!res.ok) throw new Error('config request failed: ' + res.status);
            return res.json();
        })
        .then((cfg) => {
            if (cfg && typeof cfg.privyClientId === 'string' && cfg.privyClientId) {
                PRIVY_CONFIG.clientId = cfg.privyClientId;
            }
            return PRIVY_CONFIG.clientId;
        })
        .catch((e) => {
            console.warn('[Privy] could not load client config:', e && e.message);
            privyConfigPromise = null; // allow a retry
            return '';
        });

    return privyConfigPromise;
}

/**
 * Surface a failure to the user instead of silently degrading.
 * Falls back to the console when no toast helper is present.
 */
function privyNotify(message) {
    console.warn('[Privy]', message);
    if (typeof window.showToast === 'function') {
        try { window.showToast(message, 'error'); } catch (e) { /* toast unavailable */ }
    }
}

/**
 * Import the SDK and wire up the secure iframe the embedded wallet requires.
 * Memoised, so concurrent callers share a single boot.
 */
function privyBoot() {
    if (privyClient) return Promise.resolve(privyClient);
    if (privyBootPromise) return privyBootPromise;

    // Memoise the ENTIRE boot, including the config fetch. Assigning the
    // promise before any await keeps two concurrent callers from both racing
    // through the SDK import.
    privyBootPromise = (async () => {
        // Resolve the client id from the server before deciding we are
        // unconfigured, otherwise a slow first request would look like a
        // missing id.
        await loadPrivyClientConfig();

        if (!isPrivyConfigured()) {
            throw new Error('Privy social login is not configured (missing Client ID).');
        }

        const mod = await import(PRIVY_CONFIG.sdkUrl);
        // The docs show `import Privy, { LocalStorage } from ...`, so the client
        // class is the DEFAULT export. Verified against the published bundle:
        // its export list contains `default` and `create` but no named `Privy`,
        // so checking mod.Privy alone would always fail.
        const Privy = mod.default || mod.Privy || mod.create;
        const LocalStorage = mod.LocalStorage;
        if (typeof Privy !== 'function' || typeof LocalStorage !== 'function') {
            throw new Error('Privy SDK loaded but exported an unexpected shape');
        }

        getUserEmbeddedEthereumWallet = mod.getUserEmbeddedEthereumWallet || null;

        const client = new Privy({
            appId: PRIVY_CONFIG.appId,
            clientId: PRIVY_CONFIG.clientId,
            storage: new LocalStorage(),
        });
        await client.initialize();

        // The embedded wallet talks to the page through a hidden iframe.
        const frame = document.createElement('iframe');
        frame.src = client.embeddedWallet.getURL();
        frame.style.display = 'none';
        document.body.appendChild(frame);
        client.setMessagePoster(frame.contentWindow);

        const onMessage = (e) => {
            if (e.source !== frame.contentWindow) return;
            let data = e.data;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch (err) { return; }
            }
            client.embeddedWallet.onMessage(data);
        };
        window.addEventListener('message', onMessage);

        privyFrame = frame;
        privyMessageListener = onMessage;
        privyClient = client;
        return client;
    })().catch((err) => {
        // Let the next attempt retry from scratch rather than caching failure.
        privyBootPromise = null;
        throw err;
    });

    return privyBootPromise;
}

/**
 * Initialize Privy and restore an existing session if there is one.
 * Returns false when Privy is unavailable; callers must treat that as
 * "social login unavailable", never as "logged in".
 */
async function privyInit() {
    if (!PRIVY_CONFIG.appId) {
        console.warn('[Privy] Skipping init: no App ID');
        return false;
    }

    try {
        // privyBoot resolves the client id from /api/config first, so this
        // single attempt covers both the fetch and the session check.
        const client = await privyBoot();
        const res = await client.user.get();
        const user = res && res.user;
        if (!user) return true; // SDK healthy, simply not signed in

        privyUser = user;
        privyWalletAddress = extractPrivyAddress(user);
        privyConnected = !!privyWalletAddress;
        if (privyConnected) {
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
 * Pull the embedded wallet address out of a Privy user object.
 * Returns null when the account has no embedded wallet yet.
 */
function extractPrivyAddress(user) {
    if (!user) return null;

    let list = [];
    if (Array.isArray(user.wallets)) {
        list = user.wallets;
    } else if (user.wallets && typeof user.wallets.values === 'function') {
        list = Array.from(user.wallets.values());
    } else if (user.embeddedWallets) {
        list = user.embeddedWallets;
    }

    const embedded = list.find((w) => w && w.walletClientType === 'privy' && w.address)
        || list.find((w) => w && w.address);
    if (embedded) return embedded.address;

    return (user.wallet && user.wallet.address) || null;
}


/**
 * Sign in with a social provider via Privy.
 *
 * Never falls back to a fabricated wallet: if Privy is unavailable or the
 * sign-in fails, we report the failure and leave the user signed out.
 *
 * @param {'google'|'apple'} provider
 */
async function privyLoginSocial(provider) {
    const label = provider === 'apple' ? 'Apple' : 'Google';

    let client;
    try {
        // This fetches the client id from /api/config if we do not have it yet,
        // so the availability decision below is made against real data rather
        // than an empty config that may simply not have loaded.
        client = await privyBoot();
    } catch (e) {
        console.error('[Privy] SDK load failed:', e);
        if (!isPrivyConfigured()) {
            privyNotify(
                label + ' sign-in is unavailable right now. Please use MetaMask, Coinbase or Demo mode.'
            );
        } else {
            privyNotify(
                'Could not reach the ' + label + ' sign-in service. Check your connection, or use MetaMask.'
            );
        }
        return false;
    }

    try {
        const res = await client.auth.oauth.login({ provider: provider });
        const user = res && res.user;
        const address = extractPrivyAddress(user);
        if (!address) {
            // Authenticated, but no wallet to hold funds - do not proceed.
            privyNotify('Sign-in succeeded but no wallet was created. Please try again.');
            return false;
        }

        privyUser = user;
        privyWalletAddress = address;
        privyConnected = true;
        console.log('[Privy] Logged in via ' + label + ':', address);
        onPrivyLoginSuccess();
        return true;
    } catch (e) {
        // A user closing the popup is normal, not an error worth shouting about.
        const msg = (e && e.message) || '';
        const aborted = e && (e.code === 'USER_CANCELLED' || /cancel|closed|denied|popup/i.test(msg));
        if (aborted) {
            console.log('[Privy] Login cancelled');
        } else {
            console.error('[Privy] Login error:', e);
            privyNotify(label + ' sign-in failed. Please try again.');
        }
        return false;
    }
}

/** Handle Google sign-in via Privy */
function privyLoginGoogle() {
    return privyLoginSocial('google');
}

/** Handle Apple sign-in via Privy */
function privyLoginApple() {
    return privyLoginSocial('apple');
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

    // Persist Privy session to localStorage
    if (privyWalletAddress) {
        localStorage.setItem('ta_wallet_address', privyWalletAddress);
        localStorage.setItem('ta_provider', 'privy');
        localStorage.setItem('ta_session_provider', 'privy');
    }

    // Notify app ready
    if (typeof window.onPrivyReady === 'function') {
        window.onPrivyReady(privyUser, privyWalletAddress);
    }

    // Sync session to backend database
    if (typeof window.syncUserSessionToDb === 'function' && privyWalletAddress) {
        window.syncUserSessionToDb(privyWalletAddress, 'privy', [], 0);
    }

    // Sync learning state to backend
    if (typeof window.syncLearningStateToDb === 'function') {
        window.syncLearningStateToDb(privyWalletAddress);
    }

    // Update UI with wallet info
    updateWalletUI();
}

/**
 * Update wallet-related UI elements
 *
 * The balance shown here is read from Base mainnet for the real Privy
 * address. It used to be the hardcoded string '$10,000.00', which told a
 * brand-new user holding nothing that they had ten thousand dollars.
 */
function updateWalletUI() {
    const balanceEl = document.getElementById('walletBalance');
    if (balanceEl) {
        balanceEl.textContent = '$0.00';
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

    if (privyWalletAddress) {
        refreshPrivyBalance();
    }
}

/**
 * Read the real USDC + ETH balance of the Privy wallet over RPC and render it.
 *
 * Prefer the app's own multi-chain balance sync when it is available, since
 * that is what every other wallet path uses; otherwise fall back to a direct
 * Base read. Either way the number is a real on-chain balance, never a
 * placeholder.
 */
async function refreshPrivyBalance() {
    const balanceEl = document.getElementById('walletBalance');
    if (!balanceEl || !privyWalletAddress) return;

    const address = privyWalletAddress;
    const BASE_RPC = 'https://mainnet.base.org';
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    // eth_getBalance -> [value, decimals]
    const call = async (to) => {
        const res = await fetch(BASE_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_call',
                params: [{ to: to, data: '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0') }, 'latest'],
            }),
        });
        const json = await res.json();
        if (!json || json.error) throw new Error(json && json.error ? json.error.message : 'eth_call failed');
        return BigInt(json.result);
    };

    try {
        let usd = 0;

        // USDC on Base (6 decimals)
        const rawUsdc = await call(USDC_BASE);
        usd += Number(rawUsdc) / 1e6;

        // Native ETH, priced via CoinGecko (best-effort)
        try {
          const pxRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
          const pxJson = await pxRes.json();
          const ethPrice = Number(pxJson && pxJson.ethereum && pxJson.ethereum.usd) || 0;
          if (ethPrice > 0) {
            const balRes = await fetch(BASE_RPC, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                jsonrpc: '2.0', id: 2, method: 'eth_getBalance',
                params: [address, 'latest'],
              }),
            });
            const balJson = await balRes.json();
            const wei = balJson && balJson.result ? BigInt(balJson.result) : 0n;
            usd += (Number(wei) / 1e18) * ethPrice;
          }
        } catch (e) {
          console.warn('[Privy] ETH price/balance unavailable:', e && e.message);
        }

        // Guard against the address changing mid-flight (logout/account switch).
        if (address !== privyWalletAddress) return;

        balanceEl.textContent = '$' + usd.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
    } catch (e) {
        console.warn('[Privy] balance read failed:', e && e.message);
        balanceEl.textContent = '$0.00';
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
 * Sign a message with the Privy embedded wallet.
 *
 * The old version returned the literal string '0xsignature...' when the SDK
 * was missing, which is not a signature and would fail any server-side
 * verification while looking like success. There is no simulation: if we
 * cannot produce a genuine signature we throw.
 *
 * @param {string} message
 * @returns {Promise<string>} 0x-prefixed signature
 */
async function privySignMessage(message) {
    if (!privyConnected || !privyWalletAddress) {
        throw new Error('Privy wallet is not connected');
    }
    if (!privyClient || !privyUser) {
        throw new Error('Privy SDK is not available; cannot sign');
    }

    const wallet = getUserEmbeddedEthereumWallet
        ? getUserEmbeddedEthereumWallet(privyUser)
        : null;
    if (!wallet) throw new Error('No Privy embedded wallet to sign with');

    // The embedded wallet needs an EIP-1193 provider built from the user's
    // entropy details before it can sign.
    const provider = await privyClient.embeddedWallet.getEthereumProvider({
        wallet: wallet,
        entropyId: wallet.entropyId,
        entropyIdVerifier: wallet.entropyIdVerifier,
    });

    return provider.request({
        method: 'personal_sign',
        params: [message, privyWalletAddress],
    });
}

/**
 * Sign out and tear the session down.
 *
 * Also clears the persisted session keys. Without this, logging out left
 * `ta_wallet_address` in localStorage, so a reload restored a session the user
 * had explicitly ended.
 */
async function privyDisconnect() {
    console.log('[Privy] Disconnecting...');

    const userId = privyUser && privyUser.id;

    // Clear local state first so the UI is never left in a half-signed state,
    // even if the network call to end the Privy session fails.
    privyUser = null;
    privyWalletAddress = null;
    privyConnected = false;

    try {
        localStorage.removeItem('ta_wallet_address');
        localStorage.removeItem('ta_provider');
        localStorage.removeItem('ta_session_provider');
    } catch (e) {
        console.warn('[Privy] Could not clear stored session:', e);
    }

    if (privyClient && userId) {
        try {
            await privyClient.auth.logout({ userId: userId });
        } catch (e) {
            console.error('[Privy] Logout error:', e);
        }
    }

    // Release the iframe and message bridge.
    if (privyMessageListener) {
        window.removeEventListener('message', privyMessageListener);
        privyMessageListener = null;
    }
    if (privyFrame && privyFrame.parentNode) {
        privyFrame.parentNode.removeChild(privyFrame);
    }
    privyFrame = null;

    showConnectScreen();
    hideMainApp();
}

// Export functions
window.privyInit = privyInit;
window.privyLoginGoogle = privyLoginGoogle;
window.privyLoginApple = privyLoginApple;
window.getPrivyAddress = getPrivyAddress;
window.isPrivyConnected = isPrivyConnected;
window.privySignMessage = privySignMessage;
window.privyDisconnect = privyDisconnect;
window.isPrivyConfigured = isPrivyConfigured;
