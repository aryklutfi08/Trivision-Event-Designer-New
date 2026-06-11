// Seeds a single admin account from env (idempotent). Run on every deploy.
// The admin's role, display name, and password are always synced to the env
// values, so rotating ADMIN_PASSWORD just requires re-running the seed.
require('dotenv').config();
const prisma = require('../lib/prisma');
const { hashPassword } = require('../lib/auth');

async function main() {
  const username = process.env.ADMIN_USERNAME || 'Trivision';
  const password = process.env.ADMIN_PASSWORD || 'Trivision4000!';
  const displayName = process.env.ADMIN_DISPLAY_NAME || 'TriVision Admin';
  const passwordHash = await hashPassword(password);

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    await prisma.user.update({
      where: { username },
      data: { role: 'admin', displayName, passwordHash },
    });
    console.log(`Synced admin "${username}" (role, display name, and password updated from env).`);
    return;
  }

  await prisma.user.create({
    data: { username, displayName, role: 'admin', passwordHash },
  });
  console.log(`Created admin "${username}".`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
