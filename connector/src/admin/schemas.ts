/**
 * Shared Zod validation schemas for admin API routes
 */
import { z } from 'zod';

export const CreateUserSchema = z.object({
  feishuOpenId: z.string().min(1).max(64),
  userName: z.string().max(128).optional(),
  auto_start: z.boolean().optional(),
});

export const UpdateUserSchema = z.object({
  userName: z.string().max(128).optional(),
});

export const OpenIdSchema = z.object({
  openId: z.string().min(1).max(64),
});

export const ContainerIdSchema = z.object({
  containerId: z.string().min(1).max(256),
});

export const ContainerNameSchema = z.object({
  containerName: z.string().min(1).max(256),
});
