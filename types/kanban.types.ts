// En: src/types/kanban.types.ts

// Refleja la tabla 'cards' de la BBDD
export interface Card {
    id: string; // UUID
    title: string;
    description: string | null;
    position: number;
    image_url: string | null;
    list_id: number;
    created_at: Date;
    updated_at: Date;
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