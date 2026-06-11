const { PrismaClient } = require('@prisma/client');

// Reuse a single PrismaClient across hot reloads / serverless invocations.
const globalForPrisma = globalThis;
const prisma = globalForPrisma.__tvPrisma || new PrismaClient();
if (!globalForPrisma.__tvPrisma) globalForPrisma.__tvPrisma = prisma;

module.exports = prisma;
