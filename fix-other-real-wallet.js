const fs = require('fs');
const paths = [
  'kivy-app/assets/kivy-app/assets/real-wallet.js',
  'public/kivy-app/assets/real-wallet.js'
];

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

paths.forEach(p => {
  if (!fs.existsSync(p)) { console.log('Not found:', p); return; }
  let content = fs.readFileSync(p, 'utf8');
  
  content = content.replace('// ═══════════════════════════════════════════════\r\n// CONFIGURATION', helper + '// ═══════════════════════════════════════════════\r\n// CONFIGURATION');
  
  // Fix formatEther
  content = content.replace(/typeof ethers !== 'undefined' && ethers.utils && typeof ethers.utils.formatEther === "function" \? ethers.utils.formatEther\(([^)]+)\) : \(typeof ethers !== 'undefined' && ethers.formatEther === "function" \? ethers.formatEther\(([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)\)/g, 'formatEther($1)');
  
  // Fix formatUnits
  content = content.replace(/typeof ethers !== 'undefined' && ethers.utils && typeof ethers.utils.formatUnits === "function" \? ethers.utils.formatUnits\(([^,]+), ([^)]+)\) : \(typeof ethers !== 'undefined' && ethers.formatUnits === "function" \? ethers.formatUnits\(([^,]+), ([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)\)/g, 'formatUnits($1, $2)');
  
  // Fix simpler formatUnits
  content = content.replace(/typeof ethers !== 'undefined' && ethers.formatUnits \? ethers.formatUnits\(([^,]+), ([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)/g, 'formatUnits($1, $2)');
  
  // Fix simpler formatEther
  content = content.replace(/typeof ethers !== 'undefined' && ethers.formatEther \? ethers.formatEther\(([^)]+)\) : \(Number\(([^)]+)\) \/ 1e18\)\.toString\(\)/g, 'formatEther($1)');
  
  // Fix direct ethers.formatEther
  content = content.replace(/ethers.formatEther\(([^)]+)\)/g, 'formatEther($1)');
  
  // Fix direct ethers.formatUnits
  content = content.replace(/ethers.formatUnits\(([^,]+), ([^)]+)\)/g, 'formatUnits($1, $2)');
  
  fs.writeFileSync(p, content);
  console.log('Fixed:', p);
});