// ================================
// src/types/index.ts
// ================================
export type Variables = {
  user: { userId: number; email: string; rol: string; };
};

export interface User {
  id: number;
  email: string;
  password_hash: string;
  rol: 'admin' | 'user'; // Usamos un tipo literal para más seguridad
  created_at?: Date;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}
