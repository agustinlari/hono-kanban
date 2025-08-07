#!/bin/bash

# Script para instalar dependencias de Keycloak
# Ejecutar desde backend/hono-kanban/

echo "🚀 Instalando dependencias JWT para Keycloak..."

# Verificar que estamos en el directorio correcto
if [ ! -f "package.json" ]; then
    echo "❌ Error: No se encontró package.json"
    echo "   Ejecuta este script desde backend/hono-kanban/"
    exit 1
fi

# Instalar dependencias
echo "📦 Instalando jsonwebtoken y jwks-rsa..."
npm install jsonwebtoken@^9.0.2 jwks-rsa@^3.1.0

echo "📦 Los tipos para jwks-rsa vienen incluidos con el paquete..."

# Verificar instalación
echo "✅ Verificando instalación..."
if npm list jsonwebtoken > /dev/null 2>&1 && npm list jwks-rsa > /dev/null 2>&1; then
    echo "✅ Dependencias instaladas correctamente"
else
    echo "❌ Error en la instalación"
    exit 1
fi

# Mostrar próximos pasos
echo ""
echo "🎉 ¡Dependencias instaladas!"
echo ""
echo "📋 Próximos pasos:"
echo "   1. Crear archivo .env basado en .env.example"
echo "   2. Ejecutar migración SQL para Keycloak"
echo "   3. Actualizar rutas para usar keycloakAuthMiddleware"
echo "   4. Probar la autenticación"
echo ""