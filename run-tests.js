const { spawn } = require('child_process');

const child = spawn('node', ['tests.js'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let error = '';

child.stdout.on('data', (data) => {
  output += data.toString();
  process.stdout.write(data);
});

child.stderr.on('data', (data) => {
  error += data.toString();
  process.stderr.write(data);
});

// Kill after 60 seconds
const timer = setTimeout(() => {
  console.error('\n\n[TIMEOUT] Killing tests after 60 seconds');
  child.kill('SIGTERM');
  process.exit(1);
}, 60000);

child.on('close', (code) => {
  clearTimeout(timer);
  console.log(`\n\nTests exited with code: ${code}`);
  process.exit(code);
});