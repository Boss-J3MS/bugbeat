import bcrypt from 'bcrypt';

const hash     = '$2b$12$1G26rc2OyCT6Ku8v98msaun2sdJFx97GZjOHyRLFB7WFhqSv5cKTu';
const password = 'NewPassword123';

const match = await bcrypt.compare(password, hash);
console.log('Password match:', match);

// Also generate a fresh hash
const newHash = await bcrypt.hash(password, 12);
console.log('Fresh hash:', newHash);