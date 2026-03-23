// services/imap.service.ts - Servicio de lectura de correos por IMAP
// @ts-ignore
import { ImapFlow } from 'imapflow';
// @ts-ignore
import { simpleParser } from 'mailparser';
import { pool } from '../config/database';

export interface EmailMessage {
  uid: number;
  subject: string;
  from: string;
  fromAddress: string;
  to: string;
  date: string;
  textBody: string;
  htmlBody: string;
  hasAttachments: boolean;
  attachments: { filename: string; size: number; contentType: string }[];
}

export interface EmailMatchResult {
  email: EmailMessage;
  matchedCardId: string;
  matchedCardTitle: string;
  pedidoNumber: string;
  commentCreated: boolean;
}

const imapConfig = {
  host: process.env.SMTP_HOST || 'lin232.loading.es',
  port: 993,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER || '',
    pass: process.env.EMAIL_PASSWORD || '',
  },
  tls: {
    rejectUnauthorized: false,
  },
  logger: false as any,
};

// Board ID de Pedidos
const PEDIDOS_BOARD_ID = 61;

function createImapClient(): any {
  return new ImapFlow(imapConfig as any);
}

export class ImapService {
  /**
   * Extrae todos los números de 6 dígitos de un texto
   */
  extractSixDigitNumbers(text: string): string[] {
    const matches = text.match(/\b\d{6}\b/g);
    return matches || [];
  }

  /**
   * Busca tarjetas en el tablero de Pedidos que coincidan con alguno de los números
   */
  async findMatchingCard(numbers: string[]): Promise<{ cardId: string; cardTitle: string; pedidoNumber: string } | null> {
    if (numbers.length === 0) return null;

    // Buscar tarjetas cuyo título empiece por alguno de estos números
    const placeholders = numbers.map((_, i) => `c.title LIKE $${i + 1} || '%'`).join(' OR ');
    const query = `
      SELECT c.id, c.title FROM cards c
      JOIN lists l ON c.list_id = l.id
      WHERE l.board_id = ${PEDIDOS_BOARD_ID} AND (${placeholders})
      LIMIT 1
    `;

    const result = await pool.query(query, numbers);
    if (result.rows.length > 0) {
      const card = result.rows[0];
      const matchedNum = numbers.find(n => card.title.startsWith(n)) || numbers[0];
      return { cardId: card.id, cardTitle: card.title, pedidoNumber: matchedNum };
    }
    return null;
  }

  /**
   * Genera el texto del comentario a partir de un email
   */
  formatEmailComment(email: EmailMessage): string {
    const date = email.date ? new Date(email.date).toLocaleString('es-ES') : 'Fecha desconocida';
    const preview = (email.textBody || '').substring(0, 500).trim();
    const attachmentsInfo = email.hasAttachments
      ? `\n📎 Adjuntos: ${email.attachments.map(a => a.filename).join(', ')}`
      : '';

    return `📧 {bold}Correo recibido{/bold} — ${date}\n` +
      `De: ${email.from} (${email.fromAddress})\n` +
      `Asunto: ${email.subject}\n` +
      `---\n` +
      `${preview}${preview.length >= 500 ? '...' : ''}` +
      `${attachmentsInfo}\n` +
      `[email_uid:${email.uid}]`;
  }

  /**
   * Procesa correos no leídos y los vincula a tarjetas de pedidos.
   * Retorna los resultados del procesamiento.
   */
  async processOrderEmails(systemUserId: number): Promise<{
    processed: number;
    matched: EmailMatchResult[];
    unmatched: EmailMessage[];
    errors: string[];
  }> {
    const client = createImapClient();
    const matched: EmailMatchResult[] = [];
    const unmatched: EmailMessage[] = [];
    const errors: string[] = [];
    let processed = 0;

    try {
      await client.connect();
      console.log('📬 [IMAP] Conectado - procesando correos de pedidos');

      const lock = await client.getMailboxLock('INBOX');

      try {
        const uids: any = await client.search({ seen: false }, { uid: true });

        if (!uids || !Array.isArray(uids) || uids.length === 0) {
          console.log('📬 [IMAP] No hay correos no leídos');
          return { processed: 0, matched, unmatched, errors };
        }

        console.log(`📬 [IMAP] ${uids.length} correos no leídos encontrados`);

        for (const uid of uids) {
          try {
            const message = await client.fetchOne(String(uid), {
              source: true,
              uid: true,
            }, { uid: true });

            if (!message?.source) continue;

            const parsed = await simpleParser(message.source);
            const fromAddr = (parsed as any).from?.value?.[0];
            const toField = (parsed as any).to;
            const toAddr = toField
              ? (Array.isArray(toField) ? toField : [toField])
                  .map((t: any) => t.value?.map((v: any) => v.address).join(', ')).join(', ')
              : '';

            const email: EmailMessage = {
              uid: Number(uid),
              subject: parsed.subject || '(sin asunto)',
              from: fromAddr?.name || fromAddr?.address || 'desconocido',
              fromAddress: fromAddr?.address || '',
              to: toAddr,
              date: parsed.date?.toISOString() || '',
              textBody: parsed.text || '',
              htmlBody: parsed.html || '',
              hasAttachments: (parsed.attachments?.length || 0) > 0,
              attachments: (parsed.attachments || []).map((a: any) => ({
                filename: a.filename || 'sin-nombre',
                size: a.size,
                contentType: a.contentType,
              })),
            };

            processed++;

            // Extraer números de 6 dígitos del asunto
            const numbers = this.extractSixDigitNumbers(email.subject);
            const matchResult = await this.findMatchingCard(numbers);

            if (matchResult) {
              // Crear comentario en la tarjeta
              const commentText = this.formatEmailComment(email);
              await pool.query(
                `INSERT INTO card_activity (card_id, user_id, activity_type, description)
                 VALUES ($1, $2, 'COMMENT', $3)`,
                [matchResult.cardId, systemUserId, commentText]
              );

              matched.push({
                email,
                matchedCardId: matchResult.cardId,
                matchedCardTitle: matchResult.cardTitle,
                pedidoNumber: matchResult.pedidoNumber,
                commentCreated: true,
              });

              console.log(`✅ [IMAP] Email UID ${uid} → Pedido ${matchResult.pedidoNumber} (tarjeta: ${matchResult.cardTitle})`);
            } else {
              unmatched.push(email);
              console.log(`⚠️ [IMAP] Email UID ${uid} sin match: "${email.subject}"`);
            }

            // Marcar como leído
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } catch (msgError: any) {
            errors.push(`Error procesando UID ${uid}: ${msgError.message}`);
            console.error(`❌ [IMAP] Error procesando UID ${uid}:`, msgError.message);
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
      console.log(`📬 [IMAP] Procesamiento completado. ${matched.length} vinculados, ${unmatched.length} sin match.`);
    } catch (error: any) {
      console.error('❌ [IMAP] Error de conexión:', error.message);
      throw error;
    }

    return { processed, matched, unmatched, errors };
  }

  /**
   * Recupera un correo específico por UID para el visor completo
   */
  async fetchEmailByUid(uid: number): Promise<{ html: string; subject: string; from: string; date: string } | null> {
    const client = createImapClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const message = await client.fetchOne(String(uid), {
          source: true,
          uid: true,
        }, { uid: true });

        if (!message?.source) return null;

        const parsed = await simpleParser(message.source);
        const fromAddr = (parsed as any).from?.value?.[0];

        return {
          html: parsed.html || `<pre>${parsed.text || 'Sin contenido'}</pre>`,
          subject: parsed.subject || '(sin asunto)',
          from: fromAddr?.name || fromAddr?.address || 'desconocido',
          date: parsed.date?.toISOString() || '',
        };
      } finally {
        lock.release();
      }
    } catch (error: any) {
      console.error(`❌ [IMAP] Error recuperando UID ${uid}:`, error.message);
      return null;
    } finally {
      try { await client.logout(); } catch {}
    }
  }

  async fetchEmails(limit = 10, onlyUnseen = false): Promise<EmailMessage[]> {
    const client = createImapClient();
    const emails: EmailMessage[] = [];

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        const searchCriteria = onlyUnseen ? { seen: false } : { all: true };
        const uids: any = await client.search(searchCriteria, { uid: true });

        if (!uids || !Array.isArray(uids) || uids.length === 0) return emails;

        const recentUids = uids.slice(-limit);

        for (const uid of recentUids) {
          try {
            const message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
            if (message?.source) {
              const parsed = await simpleParser(message.source);
              const fromAddr = (parsed as any).from?.value?.[0];
              const toField = (parsed as any).to;
              const toAddr = toField
                ? (Array.isArray(toField) ? toField : [toField])
                    .map((t: any) => t.value?.map((v: any) => v.address).join(', ')).join(', ')
                : '';

              emails.push({
                uid: Number(uid),
                subject: parsed.subject || '(sin asunto)',
                from: fromAddr?.name || fromAddr?.address || 'desconocido',
                fromAddress: fromAddr?.address || '',
                to: toAddr,
                date: parsed.date?.toISOString() || '',
                textBody: parsed.text || '',
                htmlBody: parsed.html || '',
                hasAttachments: (parsed.attachments?.length || 0) > 0,
                attachments: (parsed.attachments || []).map((a: any) => ({
                  filename: a.filename || 'sin-nombre',
                  size: a.size,
                  contentType: a.contentType,
                })),
              });
            }
          } catch (msgError: any) {
            console.error(`⚠️ [IMAP] Error procesando UID ${uid}:`, msgError.message);
          }
        }
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (error: any) {
      console.error('❌ [IMAP] Error de conexión:', error.message);
      throw error;
    }

    return emails;
  }

  async testConnection(): Promise<{ success: boolean; message: string; mailboxInfo?: any }> {
    const client = createImapClient();

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');
      const info = { exists: mailbox.exists, name: mailbox.path };
      await client.logout();

      return {
        success: true,
        message: `Conexión IMAP exitosa. ${info.exists} correos en INBOX.`,
        mailboxInfo: info,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Error de conexión IMAP: ${error.message}`,
      };
    }
  }
}

export const imapService = new ImapService();
