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
import { parse as parseCSV } from 'csv-parse';

// ================================
// Servicio de Obras
// ================================
class ObrasService {
  /**
   * Carga la tabla de equivalencias desde el archivo CSV
   */
  static async loadFieldMapping(): Promise<Map<number, {campo: string, tipo: string}>> {
    const mappingPath = '/home/osmos/proyectos/svelte-trello/database/tabla equivalencia campos v2.csv';

    try {
      const csvContent = await fs.readFile(mappingPath, 'utf-8');

      // Usar parseCSV de manera síncrona con el contenido ya leído
      const records = await new Promise((resolve, reject) => {
        parseCSV(csvContent, {
          columns: true,
          delimiter: ';',
          skip_empty_lines: true
        }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      }) as any[];

      const mapping = new Map<number, {campo: string, tipo: string}>();

      for (const record of records) {
        const columnaExcel = parseInt(record['Columna Excel'], 10);
        const campoBD = record['Nombre campo en base datos'];
        const tipoDato = record['Tipo dato'];

        if (!isNaN(columnaExcel) && campoBD && tipoDato) {
          // Limpiar el nombre del campo (quitar la definición SQL)
          const campoLimpio = campoBD.split(' ')[0]; // 'mercado text NULL,' -> 'mercado'
          mapping.set(columnaExcel, {
            campo: campoLimpio,
            tipo: tipoDato
          });
        }
      }

      console.log(`📊 [OBRAS] Tabla de equivalencias cargada: ${mapping.size} campos mapeados`);
      return mapping;

    } catch (error) {
      console.error('❌ [OBRAS] Error cargando tabla de equivalencias:', error);
      throw new Error(`Error cargando tabla de equivalencias: ${error.message}`);
    }
  }

  /**
   * Mapea los datos del Excel usando la tabla de equivalencias
   */
  static mapExcelData(excelRow: any, fieldMapping: Map<number, {campo: string, tipo: string}>): any {
    const mappedData: any = {};

    // Obtener las columnas del Excel como array ordenado
    const columns = Object.keys(excelRow);

    for (const [excelColumn, fieldInfo] of fieldMapping.entries()) {
      // Las columnas en Excel empiezan desde 1, pero en el array desde 0
      const columnIndex = excelColumn - 1;
      const columnKey = columns[columnIndex];

      if (columnKey !== undefined) {
        let value = excelRow[columnKey];

        // Aplicar conversiones según el tipo de dato
        switch (fieldInfo.tipo) {
          case 'text':
            if (fieldInfo.campo === 'activo') {
              // Campo especial: convertir estado a boolean
              mappedData[fieldInfo.campo] = this.convertEstadoToBool(value);
            } else {
              mappedData[fieldInfo.campo] = value || null;
            }
            break;
          case 'int4':
            mappedData[fieldInfo.campo] = this.excelToInt(value);
            break;
          case 'int8':
            mappedData[fieldInfo.campo] = this.excelToInt(value);
            break;
          case 'numeric(10 2)':
            mappedData[fieldInfo.campo] = this.excelToNumeric(value);
            break;
          case 'date':
            mappedData[fieldInfo.campo] = this.excelDateToPostgres(value);
            break;
          default:
            mappedData[fieldInfo.campo] = value || null;
            break;
        }

        if (mappedData[fieldInfo.campo] !== undefined) {
          console.log(`📊 [OBRAS] Mapeo: Columna Excel ${excelColumn} (${columnKey}) -> ${fieldInfo.campo} = ${mappedData[fieldInfo.campo]} (tipo: ${fieldInfo.tipo})`);
        }
      }
    }

    return mappedData;
  }

  /**
   * Convierte el estado del proyecto a boolean
   */
  static convertEstadoToBool(estadoValue: any): boolean {
    if (!estadoValue) return true; // Por defecto activo

    const estado = String(estadoValue).toLowerCase().trim();

    // Estados que indican que el proyecto está inactivo/cerrado
    const estadosInactivos = ['cerrado', 'cancelado', 'suspendido', 'terminado', 'finalizado'];

    return !estadosInactivos.includes(estado);
  }
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

    // Cargar tabla de equivalencias
    const fieldMapping = await this.loadFieldMapping();

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
    for (let row = 0; row <= Math.min(5, range.e.r); row++) {
      const rowData = [];
      for (let col = 0; col <= Math.min(15, range.e.c); col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = worksheet[cellAddress];
        rowData.push(cell ? cell.v : '');
      }
      console.log(`📊 [OBRAS] Fila ${row + 1}:`, rowData.slice(0, 10)); // Primeras 10 columnas
    }

    // Convertir a JSON desde la fila 2 (donde están los datos según la tabla de equivalencias)
    const rawData = XLSX.utils.sheet_to_json(worksheet, {
      range: 1, // Fila 2 (índice 1) - datos reales
      header: 1, // Usar la primera fila como headers
      defval: null // Valor por defecto para celdas vacías
    });

    console.log(`📊 [OBRAS] Datos crudos extraídos: ${rawData.length} registros`);
    if (rawData.length > 0) {
      console.log(`📊 [OBRAS] Primer registro crudo:`, JSON.stringify(rawData[0], null, 2));
      console.log(`📊 [OBRAS] Campos en primer registro:`, Object.keys(rawData[0]));
    }

    // Mapear los datos usando la tabla de equivalencias
    const mappedData = rawData.map((row, index) => {
      try {
        const mapped = this.mapExcelData(row, fieldMapping);
        if (index < 3) {
          console.log(`📊 [OBRAS] Registro ${index + 1} mapeado:`, JSON.stringify(mapped, null, 2));
        }
        return mapped;
      } catch (error) {
        console.error(`❌ [OBRAS] Error mapeando fila ${index + 1}:`, error);
        return null;
      }
    }).filter(row => row !== null);

    console.log(`📊 [OBRAS] Datos mapeados: ${mappedData.length} registros válidos`);

    return mappedData;
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
   * Actualiza un registro en la tabla proyectos
   */
  static async updateProyecto(data: any, userId: number, results: any) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Buscar si el proyecto ya existe por cod_integracion
      const codIntegracion = data.cod_integracion;

      if (!codIntegracion) {
        throw new Error(`cod_integracion inválido o vacío: ${data.cod_integracion}`);
      }

      const existingQuery = 'SELECT * FROM proyectos WHERE cod_integracion = $1 AND (creado_manualmente = false OR creado_manualmente IS NULL)';
      const existing = await client.query(existingQuery, [codIntegracion]);

      console.log(`🔍 [OBRAS] Buscando cod_integracion: ${codIntegracion}`);
      console.log(`📊 [OBRAS] Registros encontrados: ${existing.rows.length}`);

      let isUpdate = false;
      let projectId: number;
      let actionResult: any;
      
      if (existing.rows.length > 0) {
        // Actualizar registro existente
        isUpdate = true;
        projectId = existing.rows[0].id;

        // Comparar campos para detectar cambios - solo campos simplificados
        const oldRecord = existing.rows[0];
        const changes = [];

        // Lista de campos de la nueva tabla simplificada
        const fieldsToCompare = [
          'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion',
          'nombre_proyecto', 'activo', 'inmueble', 'sup_alq',
          'bt_solicitud', 'inicio_obra_prevista', 'inicio_obra_real',
          'apert_espacio_prevista', 'descripcion'
        ];

        for (const field of fieldsToCompare) {
          let newValue = data[field];
          let oldValue = oldRecord[field];

          // Aplicar conversiones según el tipo de campo
          if (field === 'codigo') {
            // Campos enteros
            if (typeof oldValue === 'string') {
              oldValue = parseInt(oldValue, 10);
              oldValue = isNaN(oldValue) ? null : oldValue;
            }
          } else if (field === 'sup_alq') {
            // Campo numérico decimal
            if (typeof oldValue === 'string') {
              oldValue = parseFloat(oldValue);
              oldValue = isNaN(oldValue) ? null : oldValue;
            }
          } else if (field === 'bt_solicitud' || field === 'inicio_obra_prevista' ||
                     field === 'inicio_obra_real' || field === 'apert_espacio_prevista') {
            // Campos de fecha - normalizar a string YYYY-MM-DD
            if (oldValue instanceof Date) {
              const year = oldValue.getFullYear();
              const month = String(oldValue.getMonth() + 1).padStart(2, '0');
              const day = String(oldValue.getDate()).padStart(2, '0');
              oldValue = `${year}-${month}-${day}`;
            } else if (typeof oldValue === 'string' && oldValue.includes('T')) {
              oldValue = oldValue.split('T')[0];
            }
          } else {
            // Campos de texto - normalizar valores nulos/vacíos
            if (newValue === null || newValue === undefined || newValue === '') {
              newValue = null;
            } else {
              newValue = String(newValue).trim();
              if (newValue === '') newValue = null;
            }

            if (oldValue === null || oldValue === undefined || oldValue === '') {
              oldValue = null;
            } else {
              oldValue = String(oldValue).trim();
              if (oldValue === '') oldValue = null;
            }
          }

          if (newValue !== oldValue) {
            changes.push({
              campo: field,
              valorAnterior: oldValue,
              valorNuevo: newValue
            });

            console.log(`🔍 [OBRAS] CAMBIO DETECTADO en cod_integracion ${codIntegracion}, campo ${field}:`);
            console.log(`   oldValue: ${JSON.stringify(oldValue)} -> newValue: ${JSON.stringify(newValue)}`);
          }
        }

        if (changes.length > 0) {
          // Realizar actualización con la nueva estructura
          const updateQuery = `
            UPDATE proyectos SET
              mercado = $1, ciudad = $2, cadena = $3, codigo = $4,
              nombre_proyecto = $5, activo = $6, inmueble = $7, sup_alq = $8,
              bt_solicitud = $9, inicio_obra_prevista = $10, inicio_obra_real = $11,
              apert_espacio_prevista = $12, descripcion = $13, fecha_cambio = CURRENT_TIMESTAMP
            WHERE cod_integracion = $14
          `;

          const values = [
            data.mercado || null,
            data.ciudad || null,
            data.cadena || null,
            data.codigo || null,
            data.nombre_proyecto || null,
            data.activo !== undefined ? data.activo : true,
            data.inmueble || null,
            data.sup_alq || null,
            data.bt_solicitud || null,
            data.inicio_obra_prevista || null,
            data.inicio_obra_real || null,
            data.apert_espacio_prevista || null,
            data.descripcion || null,
            codIntegracion
          ];

          await client.query(updateQuery, values);

          // Registrar cambios en el historial
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
          }

          console.log(`📝 [OBRAS] Proyecto actualizado: ${codIntegracion} (${changes.length} cambios)`);
          actionResult = { action: 'updated', projectId, changes: changes.length };
        } else {
          console.log(`📝 [OBRAS] Proyecto sin cambios: ${codIntegracion}`);
          actionResult = { action: 'no_changes', projectId, changes: 0 };
        }
        
      } else {
        // Crear nuevo registro con la nueva estructura simplificada
        const columns = [
          'creado_manualmente', 'mercado', 'ciudad', 'cadena', 'codigo', 'cod_integracion',
          'nombre_proyecto', 'activo', 'inmueble', 'sup_alq',
          'bt_solicitud', 'inicio_obra_prevista', 'inicio_obra_real',
          'apert_espacio_prevista', 'descripcion'
        ];

        const insertQuery = `
          INSERT INTO proyectos (${columns.join(', ')})
          VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
          RETURNING id
        `;

        const values = [
          false, // creado_manualmente - siempre false para registros del Excel
          data.mercado || null,
          data.ciudad || null,
          data.cadena || null,
          data.codigo || null,
          codIntegracion,
          data.nombre_proyecto || null,
          data.activo !== undefined ? data.activo : true,
          data.inmueble || null,
          data.sup_alq || null,
          data.bt_solicitud || null,
          data.inicio_obra_prevista || null,
          data.inicio_obra_real || null,
          data.apert_espacio_prevista || null,
          data.descripcion || null
        ];

        console.log(`📊 [OBRAS] DEBUG INSERT - Columnas: ${columns.length}, Values: ${values.length}`);

        const result = await client.query(insertQuery, values);
        projectId = result.rows[0].id;
        console.log(`💾 [OBRAS] INSERT exitoso - ID generado: ${projectId} para cod_integracion: ${codIntegracion}`);

        // Registrar creación en el historial
        try {
          const historialQuery = `
            INSERT INTO proyectos_historial (proyecto_id, usuario_id, tipo_accion)
            VALUES ($1, $2, $3)
          `;
          await client.query(historialQuery, [projectId, userId, 'CREATE']);
          console.log(`📝 [OBRAS] Historial registrado para proyecto: ${projectId}`);
        } catch (historialError) {
          console.warn(`⚠️ [OBRAS] Error registrando historial (no crítico): ${historialError.message}`);
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
      if (!row.cod_integracion) {
        console.warn(`⚠️ [OBRAS] Fila ${i + 1} sin cod_integracion válido, saltando. Valor: "${row.cod_integracion}"`);
        results.errors++;
        continue;
      }

      try {
        console.log(`📊 [OBRAS] Procesando cod_integracion: ${row.cod_integracion}`);
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
        console.error(`❌ [OBRAS] Error procesando registro ${i + 1}, cod_integracion ${row.cod_integracion}:`, error);
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