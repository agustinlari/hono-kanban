#!/bin/bash

# Script para probar endpoints de Keycloak
# Uso: ./test-keycloak-endpoints.sh [username] [password]

USERNAME=${1:-"admin@osmos.es"}
PASSWORD=${2:-"CuandoEraTardeEn2025!"}
BASE_URL="http://localhost:3001"

echo "🧪 Probando endpoints de Keycloak..."
echo "   Usuario: $USERNAME"
echo "   Base URL: $BASE_URL"
echo ""

# 1. Probar login
echo "1️⃣ Probando login..."
LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USERNAME\",\"password\":\"$PASSWORD\"}")

echo "Respuesta login:"
echo "$LOGIN_RESPONSE" | jq . 2>/dev/null || echo "$LOGIN_RESPONSE"
echo ""

# Extraer token si el login fue exitoso
ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.access_token // empty' 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ]; then
    echo "❌ Login falló - no se pudo obtener access_token"
    echo "   Verifica las credenciales y que Keycloak esté funcionando"
    exit 1
fi

echo "✅ Login exitoso - Token obtenido"
echo "   Token: ${ACCESS_TOKEN:0:50}..."
echo ""

# 2. Probar información del usuario
echo "2️⃣ Probando información del usuario..."
ME_RESPONSE=$(curl -s -X GET "$BASE_URL/auth/keycloak/me" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "Respuesta /me:"
echo "$ME_RESPONSE" | jq . 2>/dev/null || echo "$ME_RESPONSE"
echo ""

# 3. Probar refresh token
REFRESH_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.refresh_token // empty' 2>/dev/null)

if [ -n "$REFRESH_TOKEN" ]; then
    echo "3️⃣ Probando refresh token..."
    REFRESH_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/refresh" \
      -H "Content-Type: application/json" \
      -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}")
    
    echo "Respuesta refresh:"
    echo "$REFRESH_RESPONSE" | jq . 2>/dev/null || echo "$REFRESH_RESPONSE"
    echo ""
else
    echo "3️⃣ ⚠️  No se pudo obtener refresh_token - saltando prueba"
fi

# 4. Probar logout
echo "4️⃣ Probando logout..."
LOGOUT_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/keycloak/logout")

echo "Respuesta logout:"
echo "$LOGOUT_RESPONSE" | jq . 2>/dev/null || echo "$LOGOUT_RESPONSE"
echo ""

echo "🎉 Pruebas completadas!"
echo ""
echo "💡 Para usar manualmente:"
echo "   export ACCESS_TOKEN=\"$ACCESS_TOKEN\""
echo "   curl -H \"Authorization: Bearer \$ACCESS_TOKEN\" $BASE_URL/auth/keycloak/me"