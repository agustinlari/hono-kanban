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
  matchedCards: { cardId: string; cardTitle: string; boardId: number }[];
  pedidoNumber: string;
  otId: number | null;
  commentsCreated: number;
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
   * Busca tarjetas que coincidan con alguno de los números de pedido.
   * 1. Busca la tarjeta del pedido en el tablero Pedidos (por título)
   * 2. Busca la OT del pedido en la tabla pedidos → ordenes_trabajo
   * 3. Busca todas las tarjetas de cualquier tablero que tengan esa OT asignada
   */
  async findMatchingCards(numbers: string[]): Promise<{
    cards: { cardId: string; cardTitle: string; boardId: number }[];
    pedidoNumber: string;
    otId: number | null;
  } | null> {
    if (numbers.length === 0) return null;

    const cards: { cardId: string; cardTitle: string; boardId: number }[] = [];
    let matchedPedidoNumber = '';
    let otId: number | null = null;

    // 1. Buscar tarjeta del pedido en tablero Pedidos
    const placeholders = numbers.map((_, i) => `c.title LIKE $${i + 1}`).join(' OR ');
    const pedidoCardResult = await pool.query(
      `SELECT c.id, c.title, l.board_id FROM cards c
       JOIN lists l ON c.list_id = l.id
       WHERE l.board_id = ${PEDIDOS_BOARD_ID} AND (${placeholders})
       LIMIT 1`,
      numbers.map(n => `${n}%`)
    );

    if (pedidoCardResult.rows.length > 0) {
      const card = pedidoCardResult.rows[0];
      matchedPedidoNumber = numbers.find(n => card.title.startsWith(n)) || numbers[0];
      cards.push({ cardId: card.id, cardTitle: card.title, boardId: card.board_id });
    }

    if (!matchedPedidoNumber) return null;

    // 2. Buscar OT del pedido
    const pedidoResult = await pool.query(
      'SELECT numotr FROM pedidos WHERE numero_pedido = $1 AND numotr IS NOT NULL',
      [matchedPedidoNumber]
    );

    if (pedidoResult.rows.length > 0 && pedidoResult.rows[0].numotr) {
      const numotr = pedidoResult.rows[0].numotr;

      // Buscar el id de la OT en ordenes_trabajo
      const otResult = await pool.query(
        'SELECT id FROM ordenes_trabajo WHERE numotr = $1 ORDER BY numano DESC LIMIT 1',
        [numotr]
      );

      if (otResult.rows.length > 0) {
        otId = otResult.rows[0].id;

        // 3. Buscar tarjetas con esa OT asignada (en cualquier tablero, excluyendo la ya encontrada)
        const otCardsResult = await pool.query(
          `SELECT c.id, c.title, l.board_id FROM cards c
           JOIN lists l ON c.list_id = l.id
           WHERE c.ot_id = $1 AND c.id != $2`,
          [otId, cards[0]?.cardId || '']
        );

        for (const row of otCardsResult.rows) {
          cards.push({ cardId: row.id, cardTitle: row.title, boardId: row.board_id });
        }
      }
    }

    return { cards, pedidoNumber: matchedPedidoNumber, otId };
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

    return `📧 {bold}Correo recibido{/bold} — ${date} [email_uid:${email.uid}]\n` +
      `De: ${email.from} (${email.fromAddress})\n` +
      `Asunto: ${email.subject}\n` +
      `---\n` +
      `${preview}${preview.length >= 500 ? '...' : ''}` +
      `${attachmentsInfo}`;
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
            const matchResult = await this.findMatchingCards(numbers);

            if (matchResult && matchResult.cards.length > 0) {
              const commentText = this.formatEmailComment(email);

              // Crear comentario en TODAS las tarjetas que coincidan
              for (const card of matchResult.cards) {
                await pool.query(
                  `INSERT INTO card_activity (card_id, user_id, activity_type, description)
                   VALUES ($1, $2, 'COMMENT', $3)`,
                  [card.cardId, systemUserId, commentText]
                );
              }

              matched.push({
                email,
                matchedCards: matchResult.cards,
                pedidoNumber: matchResult.pedidoNumber,
                otId: matchResult.otId,
                commentsCreated: matchResult.cards.length,
              });

              const cardNames = matchResult.cards.map(c => c.cardTitle).join(', ');
              console.log(`✅ [IMAP] Email UID ${uid} → Pedido ${matchResult.pedidoNumber} → ${matchResult.cards.length} tarjeta(s): ${cardNames}`);

              // Solo marcar como leído si hubo match
              await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            } else {
              unmatched.push(email);
              console.log(`⚠️ [IMAP] Email UID ${uid} sin match: "${email.subject}" — se deja como no leído`);
            }
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
  async fetchEmailByUid(uid: number): Promise<{
    html: string;
    subject: string;
    from: string;
    date: string;
    attachments: { filename: string; size: number; contentType: string; index: number }[];
  } | null> {
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
          attachments: (parsed.attachments || []).map((a: any, index: number) => ({
            filename: a.filename || 'sin-nombre',
            size: a.size,
            contentType: a.contentType,
            index,
          })),
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

  /**
   * Descarga un adjunto específico de un correo por UID e índice
   */
  async fetchAttachment(uid: number, attachmentIndex: number): Promise<{
    content: Buffer;
    filename: string;
    contentType: string;
  } | null> {
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
        const attachment = parsed.attachments?.[attachmentIndex];

        if (!attachment) return null;

        return {
          content: attachment.content,
          filename: attachment.filename || 'adjunto',
          contentType: attachment.contentType,
        };
      } finally {
        lock.release();
      }
    } catch (error: any) {
      console.error(`❌ [IMAP] Error descargando adjunto UID ${uid}:`, error.message);
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
