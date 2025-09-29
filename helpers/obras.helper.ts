// ================================
// src/helpers/obras.helper.ts 
// ================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import { pool } from '../config/database'; 
import { keycloakAuthMiddleware } from '../middleware/keycloak-auth';
import type { Variables } from '../types';
import * as XLSX from 'xlsx';
import fs from 'fs/promises';
import path from 'path';

// ================================
// Servicio de Obras
// ================================
class ObrasService {
  /**
   * Ejecuta el scraper C# para descargar un nuevo archivo Excel
   */
  static async downloadNewExcelFile(): Promise<{ success: boolean; message: string; fileName?: string }> {
    const { exec } = require('child_process');
    const scraperPath = '/home/osmos/proyectos/svelte-trello/hono-kanban/cvi_downloader';

    try {
      console.log(`📥 [OBRAS] Iniciando descarga de nuevo Excel...`);

      return new Promise((resolve) => {
        exec('./Scrapping', { cwd: scraperPath, timeout: 120000 }, (error, stdout, stderr) => {
          if (error) {
            console.error(`❌ [OBRAS] Error ejecutando scraper:`, error.message);
            resolve({
              success: false,
              message: `Error ejecutando el scraper: ${error.message}`
            });
            return;
          }

          if (stderr) {
            console.warn(`⚠️ [OBRAS] Advertencias del scraper:`, stderr);
          }

          console.log(`✅ [OBRAS] Scraper ejecutado exitosamente`);
          console.log(`📊 [OBRAS] Output:`, stdout);

          // Extraer nombre del archivo del output
          const fileNameMatch = stdout.match(/¡Archivo descargado!: (.+)/);
          const fileName = fileNameMatch ? fileNameMatch[1] : 'archivo_descargado.xlsx';

          resolve({
            success: true,
            message: 'Excel descargado exitosamente',
            fileName
          });
        });
      });
    } catch (error) {
      console.error(`❌ [OBRAS] Error inesperado:`, error);
      return {
        success: false,
        message: `Error inesperado: ${error.message}`
      };
    }
  }
  /**
   * Lee el archivo Excel más reciente de la carpeta de descargas
   */
  static async getLatestExcelFile(): Promise<string | null> {
    const excelDir = '/home/osmos/proyectos/svelte-trello/hono-kanban/cvi_downloader/descargas_excel';
    
    try {
      const files = await fs.readdir(excelDir);
      const excelFiles = files.filter(file => file.endsWith('.xlsx') || file.endsWith('.xls'));
      
      if (excelFiles.length === 0) {
        return null;
      }
      
      // Obtener información de archivos con fechas de modificación
      const filesWithStats = await Promise.all(
        excelFiles.map(async (file) => {
          const filePath = path.join(excelDir, file);
          const stats = await fs.stat(filePath);
          return { file, path: filePath, modified: stats.mtime };
        })
      );
      
      // Ordenar por fecha de modificación (más reciente primero)
      filesWithStats.sort((a, b) => b.modified.getTime() - a.modified.getTime());

      // Limpiar archivos antiguos - mantener solo los 3 más recientes
      if (filesWithStats.length > 3) {
        const filesToDelete = filesWithStats.slice(3); // Archivos del 4° en adelante
        console.log(`🧹 [OBRAS] Limpiando ${filesToDelete.length} archivos Excel antiguos`);

        for (const fileToDelete of filesToDelete) {
          try {
            await fs.unlink(fileToDelete.path);
            console.log(`🗑️ [OBRAS] Archivo eliminado: ${fileToDelete.file}`);
          } catch (deleteError) {
            console.warn(`⚠️ [OBRAS] Error eliminando archivo ${fileToDelete.file}:`, deleteError.message);
          }
        }
      }

      return filesWithStats[0].path;
    } catch (error) {
      console.error('Error leyendo directorio Excel:', error);
      return null;
    }
  }

  /**
   * Procesa el archivo Excel y extrae los datos
   */
  static async processExcelFile(filePath: string) {
    console.log(`📊 [OBRAS] Procesando archivo Excel: ${filePath}`);
    
    const workbook = XLSX.readFile(filePath);
    console.log(`📊 [OBRAS] Hojas disponibles:`, workbook.SheetNames);
    
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    console.log(`📊 [OBRAS] Procesando hoja: ${sheetName}`);
    
    // Primero ver el rango de la hoja
    const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:A1');
    console.log(`📊 [OBRAS] Rango de la hoja: ${worksheet['!ref']}, filas: ${range.e.r + 1}, columnas: ${range.e.c + 1}`);
    
    // Leer algunas celdas de las primeras filas para ver la estructura
    console.log(`📊 [OBRAS] Muestra de datos de las primeras filas:`);
    for (let row = 0; row <= Math.min(10, range.e.r); row++) {
      const rowData = [];
      for (let col = 0; col <= Math.min(10, range.e.c); col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[cellAddress];
        rowData.push(cell ? cell.v : '');
      }
      console.log(`📊 [OBRAS] Fila ${row + 1}:`, rowData.slice(0, 5)); // Solo las primeras 5 columnas
    }
    
    // Convertir a JSON desde la fila 7 (saltando la fila 6 que son headers)
    const jsonData = XLSX.utils.sheet_to_json(worksheet, { 
      range: 6, // Fila 7 (índice 6) - saltar headers que están en la fila 6
      header: [
        'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion', 'cod_cont_proy',
        'proyecto', 'estado_proy', 'inmueble', 'direccion', 'num_local', 'plantas',
        'tipo', 'estado', 'sup_alq', 'secciones', 'franquicia', 'tipo_proy', 'imagen',
        'zonificacion_solicitud', 'zonificacion_entrega', 'plano_lic_solicitud',
        'plano_lic_entrega', 'plano_obra_solicitud', 'plano_obra_entrega',
        'aa_solicitud', 'aa_entrega', 'ci_solicitud', 'ci_entrega', 'bt_solicitud',
        'bt_entrega', 'insp_tecnica_solicitud', 'insp_tecnica_entrega',
        'lic_obra_solicitud', 'lic_obra_entrega', 'aprob_lic', 'aprob_propietario',
        'aprob_cc', 'constructora', 'apertura_cc', 'entrega_local_prevista',
        'entrega_local_real', 'inicio_obra_prevista', 'inicio_obra_real',
        'aprob_mobiliario_prevista', 'aprob_mobiliario_real', 'ent_mobiliario_prevista',
        'ent_mobiliario_real', 'ent_mercancia_prevista', 'ent_mercancia_real',
        'apert_espacio_prevista', 'apert_espacio_real', 'desc_proy', 'obs_generales'
      ]
    });
    
    console.log(`📊 [OBRAS] Datos extraídos: ${jsonData.length} registros`);
    if (jsonData.length > 0) {
      console.log(`📊 [OBRAS] Primer registro:`, JSON.stringify(jsonData[0], null, 2));
      console.log(`📊 [OBRAS] Campos en primer registro:`, Object.keys(jsonData[0]));
    }
    
    return jsonData;
  }

  /**
   * Convierte fecha de Excel a formato PostgreSQL
   */
  static excelDateToPostgres(excelDate: any): string | null {
    if (!excelDate || excelDate === '') return null;

    // Si ya es una fecha
    if (excelDate instanceof Date) {
      // Usar fecha local en lugar de UTC para evitar problemas de zona horaria
      const year = excelDate.getFullYear();
      const month = String(excelDate.getMonth() + 1).padStart(2, '0');
      const day = String(excelDate.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // Si es un número de Excel (días desde 1900-01-01)
    if (typeof excelDate === 'number') {
      const date = XLSX.SSF.parse_date_code(excelDate);
      if (date) {
        return `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;
      }
    }

    // Si es string, intentar parsearlo
    if (typeof excelDate === 'string') {
      const parsed = new Date(excelDate);
      if (!isNaN(parsed.getTime())) {
        // Usar fecha local en lugar de UTC
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1).padStart(2, '0');
        const day = String(parsed.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    }

    return null;
  }

  /**
   * Convierte valores de Excel a entero para campos int4
   */
  static excelToInt(value: any): number | null {
    if (value === null || value === undefined || value === '' || value === 'null') return null;
    
    // Si es un número, convertir a entero
    if (typeof value === 'number') {
      return Math.floor(value);
    }
    
    // Si es string, intentar convertir
    if (typeof value === 'string') {
      // Limpiar espacios y caracteres no numéricos básicos
      const cleaned = value.trim();

      // Lista de valores no enteros que deben ser null
      const nonIntegerValues = ['', 'N/A', 'n/a', 'Abierto', 'abierto', 'ABIERTO', 'null', 'NULL', '-', '--'];
      if (nonIntegerValues.includes(cleaned)) return null;

      const num = parseInt(cleaned, 10);
      return isNaN(num) ? null : num;
    }
    
    return null;
  }

  /**
   * Convierte valores de Excel a número decimal para campos numeric
   */
  static excelToNumeric(value: any): number | null {
    if (value === null || value === undefined || value === '' || value === 'null') return null;
    
    // Si es un número, devolverlo directamente
    if (typeof value === 'number') {
      return value;
    }
    
    // Si es string, intentar convertir
    if (typeof value === 'string') {
      // Limpiar espacios y caracteres no numéricos básicos
      const cleaned = value.trim().replace(',', '.');

      // Lista de valores no numéricos que deben ser null
      const nonNumericValues = ['', 'N/A', 'n/a', 'Abierto', 'abierto', 'ABIERTO', 'null', 'NULL', '-', '--'];
      if (nonNumericValues.includes(cleaned)) return null;

      const num = parseFloat(cleaned);
      return isNaN(num) ? null : num;
    }
    
    return null;
  }

  /**
   * Trunca texto para campos VARCHAR con límite de longitud
   */
  static truncateString(value: any, maxLength: number): string | null {
    if (value === null || value === undefined || value === '') return null;
    
    const str = String(value).trim();
    if (str === '' || str === 'N/A' || str === 'n/a') return null;
    
    return str.length > maxLength ? str.substring(0, maxLength) : str;
  }

  /**
   * Actualiza un registro en la tabla proyectos_inmobiliarios
   */
  static async updateProyecto(data: any, userId: number, results: any) {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');

      // Buscar si el proyecto ya existe por cod_integracion (usar la misma conversión que en INSERT)
      const codIntegracion = this.excelToInt(data.cod_integracion);

      if (!codIntegracion) {
        throw new Error(`cod_integracion inválido o vacío: ${data.cod_integracion}`);
      }

      const existingQuery = 'SELECT * FROM proyectos_inmobiliarios WHERE cod_integracion = $1';
      const existing = await client.query(existingQuery, [codIntegracion]);

      console.log(`🔍 [OBRAS] Buscando cod_integracion: ${codIntegracion} (original: ${data.cod_integracion})`);
      console.log(`📊 [OBRAS] Registros encontrados: ${existing.rows.length}`);

      let isUpdate = false;
      let projectId: number;
      let actionResult: any;
      
      if (existing.rows.length > 0) {
        // Actualizar registro existente
        isUpdate = true;
        projectId = existing.rows[0].id;
        
        // Comparar campos para detectar cambios
        const oldRecord = existing.rows[0];
        const changes = [];
        
        // Lista de campos a comparar (excluyendo id, fecha_cambio, activo)
        const fieldsToCompare = [
          'mercado', 'ciudad', 'cadena', 'codigo', 'cod_cont_proy', 'proyecto',
          'estado_proy', 'inmueble', 'direccion', 'num_local', 'plantas', 'tipo',
          'estado', 'sup_alq', 'secciones', 'franquicia', 'tipo_proy', 'imagen',
          'zonificacion_solicitud', 'zonificacion_entrega', 'plano_lic_solicitud',
          'plano_lic_entrega', 'plano_obra_solicitud', 'plano_obra_entrega',
          'aa_solicitud', 'aa_entrega', 'ci_solicitud', 'ci_entrega', 'bt_solicitud',
          'bt_entrega', 'insp_tecnica_solicitud', 'insp_tecnica_entrega',
          'lic_obra_solicitud', 'lic_obra_entrega', 'aprob_lic', 'aprob_propietario',
          'aprob_cc', 'constructora', 'apertura_cc', 'entrega_local_prevista',
          'entrega_local_real', 'inicio_obra_prevista', 'inicio_obra_real',
          'aprob_mobiliario_prevista', 'aprob_mobiliario_real', 'ent_mobiliario_prevista',
          'ent_mobiliario_real', 'ent_mercancia_prevista', 'ent_mercancia_real',
          'apert_espacio_prevista', 'apert_espacio_real', 'desc_proy', 'obs_generales'
        ];
        
        for (const field of fieldsToCompare) {
          let newValue = data[field];
          let oldValue = oldRecord[field];

          // Aplicar las mismas conversiones que en el UPDATE
          if ((field.includes('_solicitud') || field.includes('_entrega') || field.includes('_prevista') || field.includes('_real') || field === 'apertura_cc')
              && field !== 'zonificacion_solicitud' && field !== 'zonificacion_entrega') {
            // Campos de fecha (excluyendo zonificacion_* que son text)
            newValue = this.excelDateToPostgres(newValue);
            // Convertir oldValue de cualquier formato a string YYYY-MM-DD
            if (oldValue === null || oldValue === undefined) {
              oldValue = null;
            } else if (oldValue instanceof Date) {
              // Usar fecha local para ser consistente con excelDateToPostgres
              const year = oldValue.getFullYear();
              const month = String(oldValue.getMonth() + 1).padStart(2, '0');
              const day = String(oldValue.getDate()).padStart(2, '0');
              oldValue = `${year}-${month}-${day}`;
            } else if (typeof oldValue === 'string') {
              // Si ya es string de fecha, normalizar formato
              if (oldValue.includes('T')) {
                oldValue = oldValue.split('T')[0]; // '2025-05-28T10:00:00Z' -> '2025-05-28'
              } else if (oldValue.match(/^\d{4}-\d{2}-\d{2}$/)) {
                oldValue = oldValue; // Ya está en formato correcto '2025-05-28'
              } else {
                // Otros formatos de string, intentar parsear
                const parsed = new Date(oldValue);
                if (!isNaN(parsed.getTime())) {
                  // Usar fecha local para ser consistente
                  const year = parsed.getFullYear();
                  const month = String(parsed.getMonth() + 1).padStart(2, '0');
                  const day = String(parsed.getDate()).padStart(2, '0');
                  oldValue = `${year}-${month}-${day}`;
                } else {
                  oldValue = null;
                }
              }
            } else {
              // Otros tipos de objetos
              try {
                const parsed = new Date(oldValue);
                if (!isNaN(parsed.getTime())) {
                  // Usar fecha local para ser consistente
                  const year = parsed.getFullYear();
                  const month = String(parsed.getMonth() + 1).padStart(2, '0');
                  const day = String(parsed.getDate()).padStart(2, '0');
                  oldValue = `${year}-${month}-${day}`;
                } else {
                  oldValue = null;
                }
              } catch (e) {
                console.warn(`⚠️ [OBRAS] Error convirtiendo fecha para campo ${field}:`, e.message);
                oldValue = null;
              }
            }
          } else if (field === 'codigo' || field === 'cod_cont_proy' || field === 'plantas') {
            // Campos enteros
            newValue = this.excelToInt(newValue);
            // Convertir oldValue a number para comparación consistente
            oldValue = typeof oldValue === 'string' ? parseInt(oldValue, 10) : oldValue;
            oldValue = isNaN(oldValue) ? null : oldValue;
          } else if (field === 'sup_alq') {
            // Campo numérico decimal
            newValue = this.excelToNumeric(newValue);
            // Convertir oldValue a number para comparación consistente
            oldValue = typeof oldValue === 'string' ? parseFloat(oldValue) : oldValue;
            oldValue = isNaN(oldValue) ? null : oldValue;
          } else {
            // Campos de texto - normalizar valores nulos/vacíos Y espacios

            // Primero normalizar null/undefined/empty
            if (newValue === null || newValue === undefined || newValue === '' || newValue === 'null') {
              newValue = null;
            } else {
              newValue = String(newValue).trim();
              if (newValue === '' || newValue === 'null') newValue = null;
              // Para el campo secciones, tratar "0" como null para mantener consistencia
              if (field === 'secciones' && newValue === '0') newValue = null;
            }

            if (oldValue === null || oldValue === undefined || oldValue === '' || oldValue === 'null') {
              oldValue = null;
            } else {
              oldValue = String(oldValue).trim();
              if (oldValue === '' || oldValue === 'null') oldValue = null;
              // Para el campo secciones, tratar "0" como null para mantener consistencia
              if (field === 'secciones' && oldValue === '0') oldValue = null;
            }
          }
          
          if (newValue !== oldValue) {
            changes.push({
              campo: field,
              valorAnterior: oldValue,
              valorNuevo: newValue
            });

            // Debug logging detallado para entender diferencias
            console.log(`🔍 [OBRAS] CAMBIO DETECTADO en cod_integracion ${codIntegracion}, campo ${field}:`);
            console.log(`   oldValue: ${JSON.stringify(oldValue)} (tipo: ${typeof oldValue})`);
            console.log(`   newValue: ${JSON.stringify(newValue)} (tipo: ${typeof newValue})`);
            console.log(`   son iguales: ${oldValue === newValue}, son mismo tipo: ${typeof oldValue === typeof newValue}`);

            // Logging adicional para campos específicos problemáticos
            if (field.includes('date') || field.includes('fecha') || field.includes('_solicitud') || field.includes('_entrega')) {
              console.log(`   🗓️ FECHA - oldValue length: ${oldValue?.length}, newValue length: ${newValue?.length}`);
            }
          }
        }
        
        if (changes.length > 0) {
          // Realizar actualización
          const updateQuery = `
            UPDATE proyectos_inmobiliarios SET
              mercado = $1, ciudad = $2, cadena = $3, codigo = $4, cod_cont_proy = $5,
              proyecto = $6, estado_proy = $7, inmueble = $8, direccion = $9, num_local = $10,
              plantas = $11, tipo = $12, estado = $13, sup_alq = $14, secciones = $15,
              franquicia = $16, tipo_proy = $17, imagen = $18, zonificacion_solicitud = $19,
              zonificacion_entrega = $20, plano_lic_solicitud = $21, plano_lic_entrega = $22,
              plano_obra_solicitud = $23, plano_obra_entrega = $24, aa_solicitud = $25,
              aa_entrega = $26, ci_solicitud = $27, ci_entrega = $28, bt_solicitud = $29,
              bt_entrega = $30, insp_tecnica_solicitud = $31, insp_tecnica_entrega = $32,
              lic_obra_solicitud = $33, lic_obra_entrega = $34, aprob_lic = $35,
              aprob_propietario = $36, aprob_cc = $37, constructora = $38, apertura_cc = $39,
              entrega_local_prevista = $40, entrega_local_real = $41, inicio_obra_prevista = $42,
              inicio_obra_real = $43, aprob_mobiliario_prevista = $44, aprob_mobiliario_real = $45,
              ent_mobiliario_prevista = $46, ent_mobiliario_real = $47, ent_mercancia_prevista = $48,
              ent_mercancia_real = $49, apert_espacio_prevista = $50, apert_espacio_real = $51,
              desc_proy = $52, obs_generales = $53, fecha_cambio = CURRENT_TIMESTAMP
            WHERE cod_integracion = $54
          `;
          
          const values = [
            data.mercado || null, data.ciudad || null, data.cadena || null, this.excelToInt(data.codigo), this.excelToInt(data.cod_cont_proy),
            data.proyecto || null, data.estado_proy || null, data.inmueble || null, data.direccion || null, data.num_local || null,
            this.excelToInt(data.plantas), data.tipo || null, data.estado || null, this.excelToNumeric(data.sup_alq), data.secciones || null,
            data.franquicia || null, data.tipo_proy || null, data.imagen || null, data.zonificacion_solicitud || null,
            data.zonificacion_entrega || null, this.excelDateToPostgres(data.plano_lic_solicitud), this.excelDateToPostgres(data.plano_lic_entrega),
            this.excelDateToPostgres(data.plano_obra_solicitud), this.excelDateToPostgres(data.plano_obra_entrega), this.excelDateToPostgres(data.aa_solicitud),
            this.excelDateToPostgres(data.aa_entrega), this.excelDateToPostgres(data.ci_solicitud), this.excelDateToPostgres(data.ci_entrega), this.excelDateToPostgres(data.bt_solicitud),
            this.excelDateToPostgres(data.bt_entrega), this.excelDateToPostgres(data.insp_tecnica_solicitud), this.excelDateToPostgres(data.insp_tecnica_entrega),
            this.excelDateToPostgres(data.lic_obra_solicitud), this.excelDateToPostgres(data.lic_obra_entrega), data.aprob_lic || null,
            data.aprob_propietario || null, data.aprob_cc || null, data.constructora || null, this.excelDateToPostgres(data.apertura_cc),
            this.excelDateToPostgres(data.entrega_local_prevista), this.excelDateToPostgres(data.entrega_local_real), this.excelDateToPostgres(data.inicio_obra_prevista),
            this.excelDateToPostgres(data.inicio_obra_real), this.excelDateToPostgres(data.aprob_mobiliario_prevista), this.excelDateToPostgres(data.aprob_mobiliario_real),
            this.excelDateToPostgres(data.ent_mobiliario_prevista), this.excelDateToPostgres(data.ent_mobiliario_real), this.excelDateToPostgres(data.ent_mercancia_prevista),
            this.excelDateToPostgres(data.ent_mercancia_real), this.excelDateToPostgres(data.apert_espacio_prevista), this.excelDateToPostgres(data.apert_espacio_real),
            data.desc_proy || null, data.obs_generales || null, codIntegracion
          ];
          
          await client.query(updateQuery, values);
          
          // Registrar cambios en el historial (opcional - no debe fallar la transacción principal)
          try {
            for (const change of changes) {
              const historialQuery = `
                INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion, campo_modificado, valor_anterior, valor_nuevo)
                VALUES ($1, $2, $3, $4, $5, $6)
              `;
              await client.query(historialQuery, [
                projectId, userId, 'UPDATE', change.campo, change.valorAnterior, change.valorNuevo
              ]);
            }
            console.log(`📝 [OBRAS] Historial de cambios registrado para proyecto: ${projectId}`);
          } catch (historialError) {
            console.warn(`⚠️ [OBRAS] Error registrando historial de cambios (no crítico): ${historialError.message}`);
            // No relanzar el error - el UPDATE principal debe completarse
          }

          console.log(`📝 [OBRAS] Proyecto actualizado: ${codIntegracion} (${changes.length} cambios)`);
          actionResult = { action: 'updated', projectId, changes: changes.length };
        } else {
          console.log(`📝 [OBRAS] Proyecto sin cambios: ${codIntegracion}`);
          actionResult = { action: 'no_changes', projectId, changes: 0 };
        }

        console.log(`📊 [OBRAS] Comparación completa para ${codIntegracion}: ${changes.length} cambios detectados`);

        // Debug simplificado para registros con cambios
        if (existing.rows.length > 0 && changes.length > 0) {
          console.log(`🔍 [OBRAS] cod_integracion ${codIntegracion} tiene ${changes.length} cambios:`);
          console.log(`   - Cambios:`, changes.map(c => `${c.campo}: "${c.valorAnterior}" → "${c.valorNuevo}"`));
        }
        
      } else {
        // Crear nuevo registro  
        // Contar columnas manualmente para debug:
        const columns = [
          'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion', 'cod_cont_proy', 'proyecto', // 7
          'estado_proy', 'inmueble', 'direccion', 'num_local', 'plantas', 'tipo', 'estado', 'sup_alq', // 8 (total 15)
          'secciones', 'franquicia', 'tipo_proy', 'imagen', 'zonificacion_solicitud', 'zonificacion_entrega', // 6 (total 21)
          'plano_lic_solicitud', 'plano_lic_entrega', 'plano_obra_solicitud', 'plano_obra_entrega', // 4 (total 25)
          'aa_solicitud', 'aa_entrega', 'ci_solicitud', 'ci_entrega', 'bt_solicitud', 'bt_entrega', // 6 (total 31)
          'insp_tecnica_solicitud', 'insp_tecnica_entrega', 'lic_obra_solicitud', 'lic_obra_entrega', // 4 (total 35)
          'aprob_lic', 'aprob_propietario', 'aprob_cc', 'constructora', 'apertura_cc', // 5 (total 40)
          'entrega_local_prevista', 'entrega_local_real', 'inicio_obra_prevista', 'inicio_obra_real', // 4 (total 44)
          'aprob_mobiliario_prevista', 'aprob_mobiliario_real', 'ent_mobiliario_prevista', // 3 (total 47)
          'ent_mobiliario_real', 'ent_mercancia_prevista', 'ent_mercancia_real', // 3 (total 50)
          'apert_espacio_prevista', 'apert_espacio_real', 'desc_proy', 'obs_generales' // 4 (total 54)
        ];
        
        console.log(`📊 [OBRAS] DEBUG - Columnas definidas: ${columns.length}`);
        
        const insertQuery = `
          INSERT INTO proyectos_inmobiliarios (${columns.join(', ')}) 
          VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
          RETURNING id
        `;
        
        // Mapear valores exactamente en el mismo orden que las columnas
        const values = [
          // Grupo 1: datos básicos (7 valores)
          data.mercado || null, 
          data.ciudad || null, 
          data.cadena || null, 
          this.excelToInt(data.codigo),
          codIntegracion, // Usar la variable ya calculada
          this.excelToInt(data.cod_cont_proy), 
          data.proyecto || null,
          
          // Grupo 2: estado y ubicación (8 valores)
          data.estado_proy || null, 
          data.inmueble || null, 
          data.direccion || null, 
          data.num_local || null, 
          this.excelToInt(data.plantas), 
          data.tipo || null, 
          data.estado || null, 
          this.excelToNumeric(data.sup_alq),
          
          // Grupo 3: secciones y zonificación (6 valores)
          data.secciones || null, 
          data.franquicia || null, 
          data.tipo_proy || null, 
          data.imagen || null, 
          data.zonificacion_solicitud || null,
          data.zonificacion_entrega || null, 
          
          // Grupo 4: planos (4 valores)
          this.excelDateToPostgres(data.plano_lic_solicitud), 
          this.excelDateToPostgres(data.plano_lic_entrega),
          this.excelDateToPostgres(data.plano_obra_solicitud), 
          this.excelDateToPostgres(data.plano_obra_entrega), 
          
          // Grupo 5: AA, CI, BT (6 valores)
          this.excelDateToPostgres(data.aa_solicitud),
          this.excelDateToPostgres(data.aa_entrega), 
          this.excelDateToPostgres(data.ci_solicitud), 
          this.excelDateToPostgres(data.ci_entrega),
          this.excelDateToPostgres(data.bt_solicitud), 
          this.excelDateToPostgres(data.bt_entrega), 
          
          // Grupo 6: inspecciones y licencias (4 valores)
          this.excelDateToPostgres(data.insp_tecnica_solicitud),
          this.excelDateToPostgres(data.insp_tecnica_entrega), 
          this.excelDateToPostgres(data.lic_obra_solicitud), 
          this.excelDateToPostgres(data.lic_obra_entrega),
          
          // Grupo 7: aprobaciones y constructora (5 valores)
          data.aprob_lic || null, 
          data.aprob_propietario || null, 
          data.aprob_cc || null, 
          data.constructora || null,
          this.excelDateToPostgres(data.apertura_cc), 
          
          // Grupo 8: entregas e inicios (4 valores)
          this.excelDateToPostgres(data.entrega_local_prevista), 
          this.excelDateToPostgres(data.entrega_local_real),
          this.excelDateToPostgres(data.inicio_obra_prevista), 
          this.excelDateToPostgres(data.inicio_obra_real), 
          
          // Grupo 9: mobiliario (3 valores)
          this.excelDateToPostgres(data.aprob_mobiliario_prevista),
          this.excelDateToPostgres(data.aprob_mobiliario_real),
          this.excelDateToPostgres(data.ent_mobiliario_prevista),

          // Grupo 10: mercancía y espacio (3 valores)
          this.excelDateToPostgres(data.ent_mobiliario_real),
          this.excelDateToPostgres(data.ent_mercancia_prevista),
          this.excelDateToPostgres(data.ent_mercancia_real),
          
          // Grupo 11: final (4 valores)
          this.excelDateToPostgres(data.apert_espacio_prevista),
          this.excelDateToPostgres(data.apert_espacio_real), 
          data.desc_proy || null, 
          data.obs_generales || null
        ];
        
        console.log(`📊 [OBRAS] DEBUG INSERT - Columnas definidas: ${columns.length}`);
        console.log(`📊 [OBRAS] DEBUG INSERT - Values proporcionados: ${values.length}`);
        
        // Debug: log any varchar(50) fields that might be too long
        const varchar50Fields = [
          { name: 'estado_proy', value: values[7], index: 7 },
          { name: 'num_local', value: values[11], index: 11 },
          { name: 'franquicia', value: values[19], index: 19 },
          { name: 'aprob_lic', value: values[27], index: 27 },
          { name: 'aprob_propietario', value: values[28], index: 28 },
          { name: 'aprob_cc', value: values[29], index: 29 }
        ];
        
        varchar50Fields.forEach(field => {
          if (field.value && String(field.value).length > 50) {
            console.log(`🚨 [OBRAS] VARCHAR(50) TOO LONG - ${field.name}[${field.index}]: "${String(field.value).substring(0, 60)}..." (length: ${String(field.value).length})`);
          }
        });
        
        const result = await client.query(insertQuery, values);
        projectId = result.rows[0].id;
        console.log(`💾 [OBRAS] INSERT exitoso - ID generado: ${projectId} para cod_integracion: ${codIntegracion}`);
        
        // Registrar creación en el historial (opcional - no debe fallar la transacción principal)
        try {
          const historialQuery = `
            INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion)
            VALUES ($1, $2, $3)
          `;
          await client.query(historialQuery, [projectId, userId, 'CREATE']);
          console.log(`📝 [OBRAS] Historial registrado para proyecto: ${projectId}`);
        } catch (historialError) {
          console.warn(`⚠️ [OBRAS] Error registrando historial (no crítico): ${historialError.message}`);
          // No relanzar el error - el INSERT principal debe completarse
        }

        console.log(`✨ [OBRAS] Proyecto creado: ${codIntegracion}`);
        actionResult = { action: 'created', projectId, changes: 1 };
      }

      await client.query('COMMIT');
      console.log(`✅ [OBRAS] TRANSACCIÓN CONFIRMADA - Proyecto ${actionResult.action}: ${codIntegracion} (ID: ${projectId})`);
      return actionResult;
      
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Procesa el archivo Excel completo y actualiza la base de datos
   */
  static async processAndUpdateFromExcel(userId: number) {
    const filePath = await this.getLatestExcelFile();
    
    if (!filePath) {
      throw new Error('No se encontró ningún archivo Excel en el directorio');
    }
    
    console.log(`📊 [OBRAS] Iniciando procesamiento de: ${filePath}`);
    const data = await this.processExcelFile(filePath);
    
    const results = {
      processed: 0,
      created: 0,
      updated: 0,
      noChanges: 0,
      errors: 0,
      fileName: path.basename(filePath)
    };
    
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      
      // Progress logging cada 50 registros para no saturar logs
      if (i % 50 === 0 || i < 3) {
        console.log(`📊 [OBRAS] Progreso: ${i + 1}/${data.length} registros procesados`);
      }
      
      // Validar que tenga cod_integracion válido
      const codIntegracionRow = this.excelToInt(row.cod_integracion);
      if (!codIntegracionRow) {
        console.warn(`⚠️ [OBRAS] Fila ${i + 1} sin cod_integracion válido, saltando. Valor original: "${row.cod_integracion}"`);
        results.errors++;
        continue;
      }

      try {
        console.log(`📊 [OBRAS] Procesando cod_integracion: ${codIntegracionRow} (original: ${row.cod_integracion})`);
        const result = await this.updateProyecto(row, userId, results);
        results.processed++;
        
        if (result.action === 'created') {
          results.created++;
        } else if (result.action === 'updated') {
          results.updated++;
        } else if (result.action === 'no_changes') {
          results.noChanges++;
        }
        
        if (i < 3) {
          console.log(`✅ [OBRAS] Registro ${i + 1} procesado exitosamente:`, result);
        }
        
      } catch (error) {
        console.error(`❌ [OBRAS] Error procesando registro ${i + 1}, cod_integracion ${codIntegracionRow} (original: ${row.cod_integracion}):`, error);
        console.error(`❌ [OBRAS] Stack trace:`, error.stack);
        results.errors++;
      }
    }
    
    console.log(`✅ [OBRAS] Procesamiento completo:`, results);
    return results;
  }
}

// ================================
// Rutas de la API
// ================================
export const obrasRoutes = new Hono<{ Variables: Variables }>();

/**
 * POST /api/obras/download-excel
 * Descarga un nuevo archivo Excel ejecutando el scraper
 */
obrasRoutes.post('/api/obras/download-excel', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    console.log(`📥 [OBRAS] Iniciando descarga de Excel por usuario: ${user.userId}`);

    const result = await ObrasService.downloadNewExcelFile();

    if (result.success) {
      return c.json({
        success: true,
        message: result.message,
        fileName: result.fileName
      });
    } else {
      return c.json({
        success: false,
        error: result.message
      }, 500);
    }

  } catch (error) {
    console.error('❌ [OBRAS] Error descargando Excel:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/obras/download-and-process
 * Descarga un nuevo Excel y lo procesa inmediatamente
 */
obrasRoutes.post('/api/obras/download-and-process', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }

    console.log(`🔄 [OBRAS] Iniciando descarga y procesamiento completo por usuario: ${user.userId}`);

    // Paso 1: Descargar nuevo Excel
    console.log(`📥 [OBRAS] Paso 1: Descargando nuevo archivo Excel...`);
    const downloadResult = await ObrasService.downloadNewExcelFile();

    if (!downloadResult.success) {
      return c.json({
        success: false,
        error: `Error en la descarga: ${downloadResult.message}`
      }, 500);
    }

    console.log(`✅ [OBRAS] Excel descargado: ${downloadResult.fileName}`);

    // Paso 2: Procesar el Excel descargado
    console.log(`📊 [OBRAS] Paso 2: Procesando Excel descargado...`);
    const processResult = await ObrasService.processAndUpdateFromExcel(user.userId);

    return c.json({
      success: true,
      message: 'Excel descargado y procesado exitosamente',
      download: {
        fileName: downloadResult.fileName
      },
      process: processResult
    });

  } catch (error) {
    console.error('❌ [OBRAS] Error en descarga y procesamiento:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});

/**
 * POST /api/obras/process-excel
 * Procesa el archivo Excel más reciente y actualiza la base de datos
 */
obrasRoutes.post('/api/obras/process-excel', keycloakAuthMiddleware, async (c: Context<{ Variables: Variables }>) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Usuario no autenticado' }, 401);
    }
    
    console.log(`🏗️ [OBRAS] Iniciando procesamiento Excel por usuario: ${user.userId}`);
    
    const results = await ObrasService.processAndUpdateFromExcel(user.userId);
    
    return c.json({
      success: true,
      message: 'Procesamiento completado exitosamente',
      results
    });
    
  } catch (error) {
    console.error('❌ [OBRAS] Error procesando Excel:', error);
    return c.json({
      success: false,
      error: error.message || 'Error interno del servidor'
    }, 500);
  }
});