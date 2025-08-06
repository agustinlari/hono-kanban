// En: src/types/kanban.types.ts

// Refleja la tabla 'labels' de la BBDD
export interface Label {
    id: number;
    board_id: number;
    name: string;
    color: string; // Hex color like '#FF5733'
    created_at: Date;
    updated_at: Date;
}

// Refleja la tabla 'cards' de la BBDD
export interface Card {
    id: string; // UUID
    title: string;
    description: string | null;
    position: number;
    image_url: string | null;
    list_id: number;
    start_date: Date | null;
    due_date: Date | null;
    created_at: Date;
    updated_at: Date;
    labels?: Label[]; // Etiquetas asociadas a la tarjeta
    assignees?: CardAssignee[]; // Usuarios asignados a la tarjeta
}

// Refleja la tabla 'lists' de la BBDD, pero le añadimos un array para contener sus tarjetas
export interface List {
    id: number;
    title: string;
    position: number;
    board_id: number;
    created_at: Date;
    updated_at: Date;
    cards: Card[]; // Las tarjetas se anidarán aquí
}

// Refleja la tabla 'boards' de la BBDD, con sus listas y tarjetas anidadas
export interface Board {
    id: number;
    name: string;
    description: string | null;
    owner_id: number | null;
    created_at: Date;
    updated_at: Date;
    lists: List[]; // Las listas se anidarán aquí
}

// Interfaces para los payloads de creación/actualización (muy útil para validar)
export interface CreateBoardPayload {
    name: string;
    description?: string;
}

export interface CreateListPayload {
    title: string;
    board_id: number;
}

export interface CreateCardPayload {
    title: string;
    list_id: number;
}

export interface UpdateCardPositionPayload {
    sourceListId: number;
    targetListId: number;
    cardId: string;
    newIndex: number;
}

export interface UpdateCardPayload {
  title?: string;
  description?: string;
  image_url?: string;
  start_date?: Date | null;
  due_date?: Date | null;
  labels?: Label[]; // Añadir soporte para actualizar etiquetas
  assignees?: number[]; // IDs de usuarios asignados
  // No incluimos list_id ni position, ya que se manejarán con una ruta 'move' separada.
}

export interface MoveCardPayload {
  cardId: string;       // El ID de la tarjeta que se mueve
  sourceListId: number; // La lista de origen
  targetListId: number; // La lista de destino (puede ser la misma que la de origen)
  newIndex: number;     // La nueva posición (índice) en la lista de destino
}

// Interfaces para el manejo de archivos en tarjetas
export interface CardAttachmentPayload {
  cardId: string;
  isThumbnail?: boolean;
}

export interface CardAttachmentResponse {
  id: number;
  card_id: string;
  archivo_id: number;
  is_thumbnail: boolean;
  created_at: Date;
  // Metadatos del archivo
  nombre_original: string;
  nombre_guardado: string;
  ruta_relativa: string;
  mimetype: string;
  tamano_bytes: number;
  fecha_subida: Date;
}

// Interfaces para el manejo de etiquetas
export interface CreateLabelPayload {
  board_id: number;
  name: string;
  color: string;
}

export interface UpdateLabelPayload {
  name?: string;
  color?: string;
}

export interface CardLabelPayload {
  card_id: string;
  label_id: number;
}

// Colores predefinidos para etiquetas (estilo Trello)
export const LABEL_COLORS = [
  { name: 'Rojo', value: '#EB5A46' },
  { name: 'Amarillo', value: '#F2D600' },
  { name: 'Verde', value: '#61BD4F' },
  { name: 'Naranja', value: '#FF9F1A' },
  { name: 'Azul', value: '#0079BF' },
  { name: 'Púrpura', value: '#C377E0' },
  { name: 'Rosa', value: '#FF78CB' },
  { name: 'Gris', value: '#B3BAC5' },
  { name: 'Verde Lima', value: '#51E898' },
  { name: 'Cielo', value: '#00C2E0' }
] as const;

// ===================================================================
// TIPOS PARA EL SISTEMA DE ASIGNACIONES DE USUARIOS
// ===================================================================

/**
 * Interfaz para un usuario asignado a una tarjeta
 */
export interface CardAssignee {
  id: number;
  user_id: number;
  card_id: string;
  user_email: string;
  user_name?: string;
  assigned_by: number;
  assigned_at: Date;
}

/**
 * Payload para asignar un usuario a una tarjeta
 */
export interface AssignUserPayload {
  card_id: string;
  user_id: number;
}

/**
 * Payload para desasignar un usuario de una tarjeta
 */
export interface UnassignUserPayload {
  card_id: string;
  user_id: number;
}

/**
 * Respuesta de la API con información de asignación
 */
export interface AssignmentResponse {
  message: string;
  assignment?: CardAssignee;
}