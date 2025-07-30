// ================================
// src/config/env.ts
// ================================
export const JWT_SECRET = process.env.JWT_SECRET || 'secreto_para_token_jwt';
export const PORT = parseInt(process.env.PORT || '3001');
