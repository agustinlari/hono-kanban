// services/scheduler.service.ts - Tareas programadas del backend
import { SyncService } from '../helpers/sync.helper';
import { ImapService } from './imap.service';

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutos
const SYSTEM_USER_ID = 1; // Usuario "Taller Osmos" para comentarios automáticos

let intervalId: ReturnType<typeof setInterval> | null = null;

async function runScheduledSync() {
  const timestamp = new Date().toLocaleString('es-ES');
  console.log(`⏰ [Scheduler] Sincronización programada iniciada — ${timestamp}`);

  try {
    // 1. Sincronizar proyectos y pedidos desde ERP
    const syncResult = await SyncService.requestSync();
    console.log(`⏰ [Scheduler] Sync ERP: ${syncResult.message}`);

    // 2. Procesar correos de pedidos
    const imapService = new ImapService();
    const emailResult = await imapService.processOrderEmails(SYSTEM_USER_ID);
    console.log(`⏰ [Scheduler] Correos: ${emailResult.matched.length} vinculados, ${emailResult.unmatched.length} sin match`);
  } catch (error: any) {
    console.error(`❌ [Scheduler] Error en sincronización programada:`, error.message);
  }
}

export function startScheduler() {
  if (intervalId) {
    console.log('⏰ [Scheduler] Ya está corriendo');
    return;
  }

  console.log(`⏰ [Scheduler] Iniciado — ejecutando cada ${SYNC_INTERVAL_MS / 60000} minutos`);
  intervalId = setInterval(runScheduledSync, SYNC_INTERVAL_MS);

  // Ejecutar la primera sincronización tras 30 segundos (dar tiempo al backend a arrancar)
  setTimeout(runScheduledSync, 30_000);
}

export function stopScheduler() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('⏰ [Scheduler] Detenido');
  }
}
