// Utilidades para el manejo de fechas en tarjetas

export enum CardDateStatus {
  NOT_STARTED = 'not_started',     // Fecha de inicio futura
  IN_PROGRESS = 'in_progress',     // Entre fecha inicio y vencimiento
  DUE_SOON = 'due_soon',           // Vence en las próximas 24 horas
  OVERDUE = 'overdue',             // Fecha de vencimiento pasada
  COMPLETED = 'completed',         // Tarjeta marcada como completada (futuro)
  NO_DATES = 'no_dates'            // Sin fechas asignadas
}

export interface CardDateInfo {
  status: CardDateStatus;
  daysUntilDue: number | null;
  daysFromStart: number | null;
  isStarted: boolean;
  isDue: boolean;
  isOverdue: boolean;
}

/**
 * Calcula el estado de fechas de una tarjeta
 */
export function getCardDateStatus(startDate: Date | null, dueDate: Date | null): CardDateInfo {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Si no hay fechas
  if (!startDate && !dueDate) {
    return {
      status: CardDateStatus.NO_DATES,
      daysUntilDue: null,
      daysFromStart: null,
      isStarted: false,
      isDue: false,
      isOverdue: false
    };
  }

  let daysUntilDue: number | null = null;
  let daysFromStart: number | null = null;
  let status = CardDateStatus.NO_DATES;

  // Calcular días desde fecha de inicio
  if (startDate) {
    const startDateOnly = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    daysFromStart = Math.floor((today.getTime() - startDateOnly.getTime()) / (1000 * 60 * 60 * 24));
  }

  // Calcular días hasta vencimiento
  if (dueDate) {
    const dueDateOnly = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
    daysUntilDue = Math.floor((dueDateOnly.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  }

  // Determinar estado
  const isStarted = !startDate || (daysFromStart !== null && daysFromStart >= 0);
  const isOverdue = dueDate && (daysUntilDue !== null && daysUntilDue < 0);
  const isDueSoon = dueDate && (daysUntilDue !== null && daysUntilDue >= 0 && daysUntilDue <= 1);
  const isDue = dueDate && (daysUntilDue !== null && daysUntilDue === 0);

  if (isOverdue) {
    status = CardDateStatus.OVERDUE;
  } else if (isDueSoon) {
    status = CardDateStatus.DUE_SOON;
  } else if (isStarted && dueDate) {
    status = CardDateStatus.IN_PROGRESS;
  } else if (!isStarted && startDate) {
    status = CardDateStatus.NOT_STARTED;
  }

  return {
    status,
    daysUntilDue,
    daysFromStart,
    isStarted,
    isDue: isDue || false,
    isOverdue: isOverdue || false
  };
}

/**
 * Formatea una fecha para mostrar en la UI
 */
export function formatDateForDisplay(date: Date | null): string {
  if (!date) return '';
  
  const now = new Date();
  const diffTime = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  // Si es hoy
  if (diffDays === 0) {
    return 'Hoy';
  }
  
  // Si es mañana
  if (diffDays === 1) {
    return 'Mañana';
  }
  
  // Si fue ayer
  if (diffDays === -1) {
    return 'Ayer';
  }

  // Para fechas cercanas (próximos 7 días)
  if (diffDays > 0 && diffDays <= 7) {
    return `En ${diffDays} días`;
  }

  // Para fechas pasadas recientes
  if (diffDays < 0 && diffDays >= -7) {
    return `Hace ${Math.abs(diffDays)} días`;
  }

  // Formato estándar para fechas lejanas
  return date.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
  });
}

/**
 * Convierte string ISO a Date o null
 */
export function parseDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  return isNaN(date.getTime()) ? null : date;
}

/**
 * Convierte Date a string ISO para la base de datos
 */
export function formatDateForDB(date: Date | null): string | null {
  if (!date) return null;
  return date.toISOString();
}

/**
 * Valida que las fechas sean coherentes (inicio antes que vencimiento)
 */
export function validateDates(startDate: Date | null, dueDate: Date | null): { valid: boolean; error?: string } {
  if (!startDate || !dueDate) {
    return { valid: true }; // Si falta alguna fecha, no validamos
  }

  if (startDate > dueDate) {
    return { 
      valid: false, 
      error: 'La fecha de inicio no puede ser posterior a la fecha de vencimiento' 
    };
  }

  return { valid: true };
}