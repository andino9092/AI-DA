import { z } from 'zod';
import { SECRET_NAMES } from '@shared/secrets';

export const secretNameSchema = z.enum(SECRET_NAMES);

/** API keys are single-line, printable and bounded; anything else is a paste mistake. */
export const secretValueSchema = z
  .string()
  .trim()
  .min(8, 'That key looks too short.')
  .max(512, 'That key looks too long.')
  .regex(/^[\x21-\x7e]+$/, 'Keys cannot contain spaces or special characters.');
