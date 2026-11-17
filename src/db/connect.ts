import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export async function connectDatabase(uri = env.MONGODB_URI): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5_000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export const isDatabaseUp = () => mongoose.connection.readyState === 1;
