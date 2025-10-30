import { createTransporter, emailSettings } from '../config/email.config';
import fs from 'fs/promises';
import path from 'path';
import type { Transporter } from 'nodemailer';

export interface EmailData {
  to: string;
  subject: string;
  html: string;
}

export interface CardAssignedData {
  userEmail: string;
  userName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  assignedBy: string;
}

export interface CardCreatedData {
  userEmail: string;
  userName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  createdBy: string;
}

export interface CardCommentData {
  userEmail: string;
  userName: string;
  cardTitle: string;
  boardName: string;
  cardUrl: string;
  commentAuthor: string;
  commentText: string;
}

export class EmailService {
  private transporter: Transporter;
  private templatesDir: string;

  constructor() {
    this.transporter = createTransporter();
    this.templatesDir = path.join(__dirname, '../templates/emails');
  }

  async sendEmail(data: EmailData): Promise<boolean> {
    try {
      await this.transporter.sendMail({
        from: emailSettings.from,
        to: data.to,
        subject: data.subject,
        html: data.html
      });
      console.log(`✅ [Email] Enviado a ${data.to}: ${data.subject}`);
      return true;
    } catch (error: any) {
      console.error(`❌ [Email] Error enviando a ${data.to}:`, error.message);
      return false;
    }
  }

  async sendCardAssignedNotification(data: CardAssignedData): Promise<boolean> {
    const html = await this.loadTemplate('card-assigned', {
      userName: data.userName,
      cardTitle: data.cardTitle,
      boardName: data.boardName,
      cardUrl: data.cardUrl,
      assignedBy: data.assignedBy
    });

    return this.sendEmail({
      to: data.userEmail,
      subject: `Te han asignado a la tarjeta: ${data.cardTitle}`,
      html
    });
  }

  async sendCardCreatedNotification(data: CardCreatedData): Promise<boolean> {
    const html = await this.loadTemplate('card-created', {
      userName: data.userName,
      cardTitle: data.cardTitle,
      boardName: data.boardName,
      cardUrl: data.cardUrl,
      createdBy: data.createdBy
    });

    return this.sendEmail({
      to: data.userEmail,
      subject: `Nueva tarjeta en ${data.boardName}: ${data.cardTitle}`,
      html
    });
  }

  async sendCardCommentNotification(data: CardCommentData): Promise<boolean> {
    const html = await this.loadTemplate('card-comment', {
      userName: data.userName,
      cardTitle: data.cardTitle,
      boardName: data.boardName,
      cardUrl: data.cardUrl,
      commentAuthor: data.commentAuthor,
      commentText: data.commentText
    });

    return this.sendEmail({
      to: data.userEmail,
      subject: `Nuevo comentario en ${data.cardTitle}`,
      html
    });
  }

  async sendTestEmail(to: string): Promise<boolean> {
    const html = await this.loadTemplate('test', {
      userName: to,
      testDate: new Date().toLocaleString('es-ES')
    });

    return this.sendEmail({
      to,
      subject: '🧪 Email de prueba - Sistema de notificaciones Osmos',
      html
    });
  }

  private async loadTemplate(templateName: string, vars: Record<string, string>): Promise<string> {
    try {
      const templatePath = path.join(this.templatesDir, `${templateName}.html`);
      let html = await fs.readFile(templatePath, 'utf-8');

      // Reemplazar variables {{variable}}
      for (const [key, value] of Object.entries(vars)) {
        const regex = new RegExp(`{{${key}}}`, 'g');
        html = html.replace(regex, value);
      }

      return html;
    } catch (error: any) {
      console.error(`❌ [Email] Error cargando plantilla ${templateName}:`, error.message);

      // Plantilla de fallback
      return this.createFallbackTemplate(vars);
    }
  }

  private createFallbackTemplate(vars: Record<string, string>): string {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
        </head>
        <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 8px;">
            <h2 style="color: #0079bf;">Notificación de Osmos Kanban</h2>
            <div style="margin: 20px 0;">
              ${Object.entries(vars).map(([key, value]) => `<p><strong>${key}:</strong> ${value}</p>`).join('')}
            </div>
          </div>
        </body>
      </html>
    `;
  }
}

export const emailService = new EmailService();
