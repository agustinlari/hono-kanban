import nodemailer from 'nodemailer';

const smtpPort = parseInt(process.env.SMTP_PORT || '587');

export const emailConfig = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: smtpPort,
  secure: smtpPort === 465, // true para 465 (SSL), false para otros puertos (TLS)
  auth: {
    user: process.env.EMAIL_USER || 'notificaciones@osmos.es',
    pass: process.env.EMAIL_PASSWORD || ''
  },
  tls: {
    // No rechazar certificados no autorizados (útil para servidores corporativos)
    rejectUnauthorized: false
  },
  debug: true, // Activar debug para ver más información
  logger: true // Activar logger
};

export const emailSettings = {
  from: process.env.EMAIL_FROM || '"Notificaciones Osmos" <notificaciones@osmos.es>',
  appUrl: process.env.APP_URL || 'https://aplicaciones.osmos.es'
};

export const createTransporter = () => {
  const transporter = nodemailer.createTransport(emailConfig);

  // Verificar conexión al iniciar
  transporter.verify((error, success) => {
    if (error) {
      console.error('❌ Error en configuración SMTP:', error.message);
    } else {
      console.log('✅ Servidor SMTP listo para enviar emails');
    }
  });

  return transporter;
};
