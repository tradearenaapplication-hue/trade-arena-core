const fs = require('fs');
const path = 'kivy-app/assets/real-wallet.js';
let content = fs.readFileSync(path, 'utf8');

// Add helper after the comment block and before CONFIGURATION
const helper = `
// Ethers v5/v6 compatibility helpers
const formatEther = (wei) => {
  if (!window.ethers) return (Number(wei) / 1e18).toString();
  try {
    return window.ethers.formatEther ? window.ethers.formatEther(wei) : 
           (window.ethers.utils?.formatEther ? window.ethers.utils.formatEther(wei) : (Number(wei) / 1e18).toString());
  } catch { return (Number(wei) / 1e18).toString(); }
};

const formatUnits = (wei, unit) => {
  if (!window.ethers) return (Number(wei) / 1e18).toString();
  try {
    return window.ethers.formatUnits ? window.ethers.formatUnits(wei, unit) : 
           (window.ethers.utils?.formatUnits ? window.ethers.utils.formatUnits(wei, unit) : (Number(wei) / 1e18).toString());
  } catch { return (Number(wei) / 1e18).toString(); }
};
`;

content = content.replace('// ═══════════════════════════════════════════════\r\n// CONFIGURATION', helper + '// ═══════════════════════════════════════════════\r\n// CONFIGURATION');

// Fix formatEther calls - complex ternary with ethers.utils
content = content.replace(/typeof ethers !== 'undefined' && ethers.utils && typeof ethers.utils.formatEther === "function" \? ethers.utils.formatEther\(([^)]+)\) : \(typeof ethers !== 'undefined' && ethers.formatEther === "function" \? ethers.formatEther\(([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)\)/g, 'formatEther($1)');

// Fix formatUnits calls - complex ternary with ethers.utils
content = content.replace(/typeof ethers !== 'undefined' && ethers.utils && typeof ethers.utils.formatUnits === "function" \? ethers.utils.formatUnits\(([^,]+), ([^)]+)\) : \(typeof ethers !== 'undefined' && ethers.formatUnits === "function" \? ethers.formatUnits\(([^,]+), ([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)\)/g, 'formatUnits($1, $2)');

// Fix simpler formatUnits - ternary with ethers.formatUnits
content = content.replace(/typeof ethers !== 'undefined' && ethers.formatUnits \? ethers.formatUnits\(([^,]+), ([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)/g, 'formatUnits($1, $2)');

// Fix simpler formatEther - ternary with ethers.formatEther
content = content.replace(/typeof ethers !== 'undefined' && ethers.formatEther \? ethers.formatEther\(([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)/g, 'formatEther($1)');

// Fix direct ethers.formatEther calls
content = content.replace(/ethers.formatEther\(([^)]+)\)/g, 'formatEther($1)');

// Fix direct ethers.formatUnits calls
content = content.replace(/ethers.formatUnits\(([^,]+), ([^)]+)\)/g, 'formatUnits($1, $2)');

fs.writeFileSync(path, content);
console.log('Fixed kivy-app/assets/real-wallet.js');