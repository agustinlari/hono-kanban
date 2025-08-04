// ================================
// src/types/index.ts
// ================================
export type Variables = {
  user: { userId: number; email: string; rol: string; };
  boardId?: number;
  userPermissions?: BoardPermissions;
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

// Interfaces para el sistema de permisos
export interface BoardPermissions {
  can_view: boolean;
  can_create_cards: boolean;
  can_edit_cards: boolean;
  can_move_cards: boolean;
  can_delete_cards: boolean;
  can_manage_labels: boolean;
  can_add_members: boolean;
  can_remove_members: boolean;
  can_edit_board: boolean;
}

export interface BoardMember extends BoardPermissions {
  id: number;
  board_id: number;
  user_id: number;
  invited_by: number | null;
  joined_at: Date;
  updated_at: Date;
  // Información del usuario (cuando se hace JOIN)
  user_email?: string;
  is_owner?: boolean;
}

export interface PermissionRole extends BoardPermissions {
  id: number;
  name: string;
  description: string | null;
}

export interface UserBoardAccess {
  board_id: number;
  board_name: string;
  user_id: number;
  user_email: string;
  is_owner: boolean;
  permissions: BoardPermissions;
  joined_at: Date;
}

// Payloads para requests
export interface AddMemberPayload {
  board_id: number;
  user_email: string;
  role_name?: string; // Usar rol predefinido
  permissions?: Partial<BoardPermissions>; // O permisos custom
}

export interface UpdateMemberPermissionsPayload {
  board_id: number;
  user_id: number;
  permissions: Partial<BoardPermissions>;
}

export interface RemoveMemberPayload {
  board_id: number;
  user_id: number;
}

// Enum para acciones que requieren permisos
export enum PermissionAction {
  VIEW_BOARD = 'can_view',
  CREATE_CARDS = 'can_create_cards',
  EDIT_CARDS = 'can_edit_cards',
  MOVE_CARDS = 'can_move_cards',
  DELETE_CARDS = 'can_delete_cards',
  MANAGE_LABELS = 'can_manage_labels',
  ADD_MEMBERS = 'can_add_members',
  REMOVE_MEMBERS = 'can_remove_members',
  EDIT_BOARD = 'can_edit_board'
}
