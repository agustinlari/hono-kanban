// services/imap.service.ts - Servicio de lectura de correos por IMAP
// @ts-ignore
import { ImapFlow } from 'imapflow';
// @ts-ignore
import { simpleParser } from 'mailparser';

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

export class ImapService {
  async fetchEmails(limit = 10, onlyUnseen = false): Promise<EmailMessage[]> {
    const client = new ImapFlow(imapConfig as any);
    const emails: EmailMessage[] = [];

    try {
      await client.connect();
      console.log('📬 [IMAP] Conectado al servidor');

      const lock = await client.getMailboxLock('INBOX');

      try {
        const searchCriteria = onlyUnseen ? { seen: false } : { all: true };
        const uids: any = await client.search(searchCriteria, { uid: true });

        if (!uids || !Array.isArray(uids) || uids.length === 0) {
          console.log('📬 [IMAP] No hay correos que coincidan con los criterios');
          return emails;
        }

        // Tomar los últimos N correos
        const recentUids = uids.slice(-limit);

        for (const uid of recentUids) {
          try {
            const message = await client.fetchOne(String(uid), {
              source: true,
              uid: true,
            }, { uid: true });

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
      console.log(`📬 [IMAP] Desconectado. ${emails.length} correos leídos.`);
    } catch (error: any) {
      console.error('❌ [IMAP] Error de conexión:', error.message);
      throw error;
    }

    return emails;
  }

  async testConnection(): Promise<{ success: boolean; message: string; mailboxInfo?: any }> {
    const client = new ImapFlow(imapConfig as any);

    try {
      await client.connect();
      const mailbox = await client.mailboxOpen('INBOX');
      const info = {
        exists: mailbox.exists,
        name: mailbox.path,
      };
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
