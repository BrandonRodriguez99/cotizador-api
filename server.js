require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sql = require("mssql");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");

const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const APP_URL   = process.env.APP_URL   || "http://localhost:5173";

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || "udat-cotizador-secret-2024";

app.use(cors());
app.use(express.json({ limit: '25mb' }));

// Directorio para archivos de facturas
const FACTURAS_DIR = path.join(__dirname, 'uploads', 'facturas');
if (!fs.existsSync(FACTURAS_DIR)) fs.mkdirSync(FACTURAS_DIR, { recursive: true });

// CONFIG SQL
const config = {
  user:     process.env.DB_USER     || "BiBandonRodriguez",
  password: process.env.DB_PASSWORD || "BiRodriguez2024#$.#",
  server:   process.env.DB_SERVER   || "udatserver.southcentralus.cloudapp.azure.com",
  database: process.env.DB_NAME     || "biUDAT",
  port:     Number(process.env.DB_PORT) || 1433,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

// CONEXIÓN SQL
let pool;

sql
  .connect(config)
  .then((p) => {
    pool = p;
    console.log("✅ Conectado a SQL Server");

    (async () => {
      try {
        await pool.request().query(`
          IF OBJECT_ID('dbo.ConceptosCosto','U') IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.ConceptosCosto') AND name = 'TipoCosto')
          BEGIN
            ALTER TABLE dbo.ConceptosCosto ADD TipoCosto VARCHAR(50) NULL;
          END
        `);
        console.log("✅ Asegurada columna TipoCosto");

        await pool.request().query(`
          IF OBJECT_ID('dbo.Proveedores','U') IS NULL
          BEGIN
            CREATE TABLE dbo.Proveedores (
              ProveedorId INT IDENTITY(1,1) PRIMARY KEY,
              Nombre NVARCHAR(250) NOT NULL,
              RFC NVARCHAR(50) NULL,
              Correo NVARCHAR(150) NULL,
              Telefono NVARCHAR(50) NULL,
              Contacto NVARCHAR(200) NULL,
              Activo BIT NOT NULL DEFAULT 1,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FechaModificacion DATETIME2 NULL
            );
          END

          IF OBJECT_ID('dbo.UnidadesNegocio','U') IS NULL
          BEGIN
            CREATE TABLE dbo.UnidadesNegocio (
              UnidadNegocioId INT IDENTITY(1,1) PRIMARY KEY,
              Nombre NVARCHAR(250) NOT NULL,
              Responsable NVARCHAR(200) NULL,
              Area NVARCHAR(200) NULL,
              Activo BIT NOT NULL DEFAULT 1,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FechaModificacion DATETIME2 NULL
            );
          END

          IF OBJECT_ID('dbo.OrdenesCompra','U') IS NULL
          BEGIN
            CREATE TABLE dbo.OrdenesCompra (
              OrdenCompraId INT IDENTITY(1,1) PRIMARY KEY,
              Folio NVARCHAR(50) NOT NULL,
              UnidadNegocioId INT NOT NULL,
              ProveedorId INT NOT NULL,
              Fecha DATE NOT NULL,
              Observaciones NVARCHAR(2000) NULL,
              Subtotal DECIMAL(18,2) NOT NULL DEFAULT 0,
              Iva DECIMAL(18,2) NOT NULL DEFAULT 0,
              Total DECIMAL(18,2) NOT NULL DEFAULT 0,
              Creador NVARCHAR(150) NULL,
              Rechazado BIT NOT NULL DEFAULT 0,
              RechazadoPor NVARCHAR(150) NULL,
              FechaRechazo DATETIME2 NULL,
              MotivoRechazo NVARCHAR(1000) NULL,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              ModificadoPor NVARCHAR(150) NULL,
              FechaModificacion DATETIME2 NULL,
              FOREIGN KEY (UnidadNegocioId) REFERENCES dbo.UnidadesNegocio(UnidadNegocioId),
              FOREIGN KEY (ProveedorId) REFERENCES dbo.Proveedores(ProveedorId)
            );
          END

          IF OBJECT_ID('dbo.OrdenesCompraLineas','U') IS NULL
          BEGIN
            CREATE TABLE dbo.OrdenesCompraLineas (
              OrdenCompraLineaId INT IDENTITY(1,1) PRIMARY KEY,
              OrdenCompraId INT NOT NULL,
              Cantidad DECIMAL(18,2) NOT NULL DEFAULT 1,
              Descripcion NVARCHAR(1000) NOT NULL,
              UnidadMedida NVARCHAR(100) NULL,
              PrecioUnitario DECIMAL(18,2) NOT NULL DEFAULT 0,
              Total DECIMAL(18,2) NOT NULL DEFAULT 0,
              OrdenLinea INT NULL,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (OrdenCompraId) REFERENCES dbo.OrdenesCompra(OrdenCompraId)
            );
          END

          IF OBJECT_ID('dbo.OrdenesCompraAprobaciones','U') IS NULL
          BEGIN
            CREATE TABLE dbo.OrdenesCompraAprobaciones (
              OrdenCompraAprobacionId INT IDENTITY(1,1) PRIMARY KEY,
              OrdenCompraId INT NOT NULL,
              Paso INT NOT NULL,
              Etiqueta NVARCHAR(200) NOT NULL,
              Aprobado BIT NOT NULL DEFAULT 0,
              AprobadoPor NVARCHAR(150) NULL,
              FechaAprobacion DATETIME2 NULL,
              Comentarios NVARCHAR(1000) NULL,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (OrdenCompraId) REFERENCES dbo.OrdenesCompra(OrdenCompraId)
            );
          END

          -- Columnas de margen desglosado en Cotizaciones
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='MargenUtilidadPctDirectos')
            ALTER TABLE dbo.Cotizaciones ADD MargenUtilidadPctDirectos DECIMAL(18,4) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='MargenUtilidadPctIndirectos')
            ALTER TABLE dbo.Cotizaciones ADD MargenUtilidadPctIndirectos DECIMAL(18,4) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='MargenUtilidadDirectos')
            ALTER TABLE dbo.Cotizaciones ADD MargenUtilidadDirectos DECIMAL(18,2) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='MargenUtilidadIndirectos')
            ALTER TABLE dbo.Cotizaciones ADD MargenUtilidadIndirectos DECIMAL(18,2) NULL;

          -- Columnas de aprobación en Cotizaciones
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='AprobadoPor')
            ALTER TABLE dbo.Cotizaciones ADD AprobadoPor NVARCHAR(150) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='FechaAprobacion')
            ALTER TABLE dbo.Cotizaciones ADD FechaAprobacion DATETIME2 NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='ComentariosAprobacion')
            ALTER TABLE dbo.Cotizaciones ADD ComentariosAprobacion NVARCHAR(1000) NULL;

          -- Columnas de archivo en OrdenesCompraFacturas
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompraFacturas') AND name='ArchivoNombre')
            ALTER TABLE dbo.OrdenesCompraFacturas ADD ArchivoNombre NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompraFacturas') AND name='ArchivoContenido')
            ALTER TABLE dbo.OrdenesCompraFacturas ADD ArchivoContenido VARBINARY(MAX) NULL;

          -- Agregar columna Tipo a OrdenesCompra si no existe
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='Tipo')
            ALTER TABLE dbo.OrdenesCompra ADD Tipo NVARCHAR(20) NOT NULL CONSTRAINT DF_OC_Tipo DEFAULT 'compras';

          -- Columnas extendidas para SolicitudesFondos (datos de pago)
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Terminal')
            ALTER TABLE dbo.SolicitudesFondos ADD Terminal NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='FechaPago')
            ALTER TABLE dbo.SolicitudesFondos ADD FechaPago DATE NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='FormaPago')
            ALTER TABLE dbo.SolicitudesFondos ADD FormaPago NVARCHAR(20) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Moneda')
            ALTER TABLE dbo.SolicitudesFondos ADD Moneda NVARCHAR(20) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='EntregarA')
            ALTER TABLE dbo.SolicitudesFondos ADD EntregarA NVARCHAR(20) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='NombreBanco')
            ALTER TABLE dbo.SolicitudesFondos ADD NombreBanco NVARCHAR(200) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Ciudad')
            ALTER TABLE dbo.SolicitudesFondos ADD Ciudad NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='EstadoBanco')
            ALTER TABLE dbo.SolicitudesFondos ADD EstadoBanco NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Pais')
            ALTER TABLE dbo.SolicitudesFondos ADD Pais NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='NumSucursal')
            ALTER TABLE dbo.SolicitudesFondos ADD NumSucursal NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='NombreSucursal')
            ALTER TABLE dbo.SolicitudesFondos ADD NombreSucursal NVARCHAR(200) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Swift')
            ALTER TABLE dbo.SolicitudesFondos ADD Swift NVARCHAR(50) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='NumCuenta')
            ALTER TABLE dbo.SolicitudesFondos ADD NumCuenta NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='ClaveInterbancaria')
            ALTER TABLE dbo.SolicitudesFondos ADD ClaveInterbancaria NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='AEA')
            ALTER TABLE dbo.SolicitudesFondos ADD AEA NVARCHAR(100) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Aprobado1')
            ALTER TABLE dbo.SolicitudesFondos ADD Aprobado1 BIT NOT NULL DEFAULT 0;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='AprobadoPor1')
            ALTER TABLE dbo.SolicitudesFondos ADD AprobadoPor1 NVARCHAR(150) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='FechaAprobacion1')
            ALTER TABLE dbo.SolicitudesFondos ADD FechaAprobacion1 DATETIME2 NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='Aprobado2')
            ALTER TABLE dbo.SolicitudesFondos ADD Aprobado2 BIT NOT NULL DEFAULT 0;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='AprobadoPor2')
            ALTER TABLE dbo.SolicitudesFondos ADD AprobadoPor2 NVARCHAR(150) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.SolicitudesFondos') AND name='FechaAprobacion2')
            ALTER TABLE dbo.SolicitudesFondos ADD FechaAprobacion2 DATETIME2 NULL;

          IF OBJECT_ID('dbo.OrdenesCompraFacturas','U') IS NULL
          BEGIN
            CREATE TABLE dbo.OrdenesCompraFacturas (
              FacturaId INT IDENTITY(1,1) PRIMARY KEY,
              OrdenCompraId INT NOT NULL,
              NumeroFactura NVARCHAR(100) NOT NULL,
              FechaFactura DATE NOT NULL,
              Monto DECIMAL(18,2) NOT NULL DEFAULT 0,
              Observaciones NVARCHAR(2000) NULL,
              RegistradoPor NVARCHAR(150) NULL,
              FechaRegistro DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (OrdenCompraId) REFERENCES dbo.OrdenesCompra(OrdenCompraId)
            );
          END

          IF OBJECT_ID('dbo.SolicitudesFondos','U') IS NULL
          BEGIN
            CREATE TABLE dbo.SolicitudesFondos (
              SolicitudId INT IDENTITY(1,1) PRIMARY KEY,
              OrdenCompraId INT NOT NULL,
              FacturaId INT NULL,
              Folio NVARCHAR(50) NOT NULL,
              Monto DECIMAL(18,2) NOT NULL DEFAULT 0,
              Concepto NVARCHAR(2000) NULL,
              Estado NVARCHAR(50) NOT NULL DEFAULT 'pendiente',
              CreadoPor NVARCHAR(150) NULL,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (OrdenCompraId) REFERENCES dbo.OrdenesCompra(OrdenCompraId)
            );
          END

          IF OBJECT_ID('dbo.EvaluacionesProveedor','U') IS NULL
          BEGIN
            CREATE TABLE dbo.EvaluacionesProveedor (
              EvaluacionId INT IDENTITY(1,1) PRIMARY KEY,
              OrdenCompraId INT NOT NULL,
              Tipo NVARCHAR(20) NOT NULL DEFAULT 'compras',
              Criterios NVARCHAR(MAX) NULL,
              PuntajeCalidad DECIMAL(5,2) NULL,
              PuntajeTiempos DECIMAL(5,2) NULL,
              PuntajeCantidad DECIMAL(5,2) NULL,
              PuntajePosventa DECIMAL(5,2) NULL,
              PuntajeTotal DECIMAL(5,2) NULL,
              Observaciones NVARCHAR(2000) NULL,
              Departamento NVARCHAR(200) NULL,
              Evaluador NVARCHAR(150) NULL,
              FechaEvaluacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (OrdenCompraId) REFERENCES dbo.OrdenesCompra(OrdenCompraId)
            );
          END

          IF OBJECT_ID('dbo.Modalidades','U') IS NULL
          BEGIN
            CREATE TABLE dbo.Modalidades (
              ModalidadId INT IDENTITY(1,1) PRIMARY KEY,
              Nombre NVARCHAR(250) NOT NULL,
              Descripcion NVARCHAR(1000) NULL,
              Activo BIT NOT NULL DEFAULT 1,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FechaModificacion DATETIME2 NULL
            );
          END
        `);
        console.log("✅ Tablas de catálogos aseguradas");

        // Tablas de autenticación
        await pool.request().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'Usuarios' AND schema_id = SCHEMA_ID('dbo'))
          BEGIN
            CREATE TABLE dbo.Usuarios (
              UsuarioId         INT IDENTITY(1,1) PRIMARY KEY,
              Correo            NVARCHAR(150) NOT NULL,
              PasswordHash      NVARCHAR(255) NOT NULL,
              Nombre            NVARCHAR(200) NOT NULL,
              Rol               NVARCHAR(50)  NOT NULL DEFAULT 'empleado',
              DebeReiniciarPass BIT           NOT NULL DEFAULT 1,
              Activo            BIT           NOT NULL DEFAULT 1,
              FechaCreacion     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
              UltimoAcceso      DATETIME2     NULL,
              CONSTRAINT UQ_Usuarios_Correo UNIQUE (Correo)
            )
          END
        `);

        await pool.request().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'TokensRecuperacion' AND schema_id = SCHEMA_ID('dbo'))
          BEGIN
            CREATE TABLE dbo.TokensRecuperacion (
              TokenId       INT IDENTITY(1,1) PRIMARY KEY,
              UsuarioId     INT           NOT NULL,
              Token         NVARCHAR(20)  NOT NULL,
              Expiracion    DATETIME2     NOT NULL,
              Usado         BIT           NOT NULL DEFAULT 0,
              FechaCreacion DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
              CONSTRAINT FK_TokensRec_Usuarios FOREIGN KEY (UsuarioId) REFERENCES dbo.Usuarios(UsuarioId)
            )
          END
        `);

        const countRes = await pool.request().query("SELECT COUNT(*) AS total FROM dbo.Usuarios");
        if (countRes.recordset[0].total === 0) {
          const hash = await bcrypt.hash("Udat2024!", 10);
          await pool
            .request()
            .input("Correo", sql.NVarChar(150), "admin@udat.com")
            .input("Hash", sql.NVarChar(255), hash)
            .input("Nombre", sql.NVarChar(200), "Administrador")
            .input("Rol", sql.NVarChar(50), "admin")
            .query(`INSERT INTO dbo.Usuarios (Correo, PasswordHash, Nombre, Rol, DebeReiniciarPass)
                    VALUES (@Correo, @Hash, @Nombre, @Rol, 1)`);
          console.log("✅ Usuario admin creado: admin@udat.com / Udat2024!");
        }
        console.log("✅ Tablas de autenticación aseguradas");
      } catch (e) {
        console.log("❌ Error asegurando tablas:", e);
      }
    })();
  })
  .catch((err) => console.log("❌ Error SQL:", err));

// ─── Email helpers ────────────────────────────────────────────────────────────
const mailer = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: "smtp.office365.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: false },
    })
  : null;

if (mailer) {
  mailer.verify((err) => {
    if (err) console.log("⚠️ SMTP no conectó:", err.message);
    else     console.log("✅ SMTP Office365 listo — correos habilitados");
  });
} else {
  console.log("⚠️ SMTP no configurado (SMTP_USER / SMTP_PASS ausentes)");
}

async function sendMail(to, subject, html) {
  if (!mailer || !to || !to.length) {
    console.log(`⚠️ Email no enviado (${!mailer ? "SMTP sin config" : "sin destinatarios"}): ${subject}`);
    return;
  }
  try {
    await mailer.sendMail({
      from: `"Sistema UDAT" <${SMTP_USER}>`,
      to: to.join(","),
      subject,
      html,
    });
    console.log(`✅ Email enviado a: ${to.join(",")}`);
  } catch (e) {
    console.log("⚠️ Error enviando email:", e.message);
  }
}

async function getEmailsDeRol(rol) {
  if (!pool) return [];
  try {
    const r = await pool.request()
      .input("rol", sql.NVarChar(50), rol)
      .query("SELECT Correo FROM dbo.Usuarios WHERE Rol=@rol AND Activo=1");
    return r.recordset.map((u) => u.Correo);
  } catch { return []; }
}

function emailOrdenCreada(folio, proveedor, total) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e3a5f">Nueva Orden de Compra — Requiere Autorización</h2>
      <p>Se ha creado una nueva orden de compra que requiere su autorización:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr style="background:#f3f4f6"><td style="padding:8px;font-weight:bold">Proveedor</td><td style="padding:8px">${proveedor}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Total</td><td style="padding:8px">$${Number(total).toFixed(2)}</td></tr>
      </table>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ingresar al sistema para autorizar
      </a>
    </div>`;
}

function emailPasoAprobado(folio, proveedor, total, paso) {
  const label = paso === 1 ? "Administración" : "Secretaría Académica";
  const next  = paso === 1 ? "Secretaría Académica" : null;
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e3a5f">Orden ${folio} aprobada por ${label}</h2>
      ${next ? `<p>La orden requiere ahora la autorización de <strong>${next}</strong>.</p>` : "<p>La orden ha sido <strong>completamente aprobada</strong>.</p>"}
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr style="background:#f3f4f6"><td style="padding:8px;font-weight:bold">Proveedor</td><td style="padding:8px">${proveedor}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Total</td><td style="padding:8px">$${Number(total).toFixed(2)}</td></tr>
      </table>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ingresar al sistema
      </a>
    </div>`;
}

async function getEmailDeUsuario(nombre) {
  if (!pool || !nombre) return [];
  try {
    const r = await pool.request()
      .input("nombre", sql.NVarChar(200), nombre)
      .query("SELECT Correo FROM dbo.Usuarios WHERE Nombre=@nombre AND Activo=1");
    return r.recordset.map(u => u.Correo).filter(Boolean);
  } catch { return []; }
}

function emailCotizacionPendiente(folio, cliente, curso, total, creadoPor) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e3a5f">Nueva Cotización — Pendiente de Aprobación</h2>
      <p>Se ha generado una cotización que requiere su autorización:</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Cliente</td><td style="padding:8px">${cliente || '-'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Curso</td><td style="padding:8px">${curso || '-'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Total con ganancia</td><td style="padding:8px">$${Number(total || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Creado por</td><td style="padding:8px">${creadoPor || '-'}</td></tr>
      </table>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ingresar al sistema para autorizar
      </a>
    </div>`;
}

function emailCotizacionResuelta(folio, cliente, curso, total, estado, comentarios, aprobadoPor) {
  const aprobada = estado === 'Aprobada';
  const color = aprobada ? '#15803d' : '#b91c1c';
  const bg    = aprobada ? '#f0fdf4' : '#fef2f2';
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:${color}">Cotización ${folio} — ${estado}</h2>
      <div style="background:${bg};border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0;color:${color};font-weight:600">
          ${aprobada ? '✅ Tu cotización ha sido aprobada.' : '❌ Tu cotización ha sido rechazada.'}
        </p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Cliente</td><td style="padding:8px">${cliente || '-'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Curso</td><td style="padding:8px">${curso || '-'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Total</td><td style="padding:8px">$${Number(total || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Revisado por</td><td style="padding:8px">${aprobadoPor || '-'}</td></tr>
        ${comentarios ? `<tr><td style="padding:8px;font-weight:bold">Comentarios</td><td style="padding:8px">${comentarios}</td></tr>` : ''}
      </table>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ver en el sistema
      </a>
    </div>`;
}

// Helpers
const ensurePool = (res) => {
  if (!pool) { res.status(500).send("No hay conexión SQL"); return false; }
  return true;
};

const buildSqlParams = (request, data) => {
  Object.entries(data).forEach(([key, value], index) => {
    request.input(`p${index}`, value);
  });
};

const insertCatalogItem = async (table, data) => {
  const fields = Object.keys(data);
  const columns = fields.map((field) => `[${field}]`).join(", ");
  const values = fields.map((_, index) => `@p${index}`).join(", ");
  const request = pool.request();
  buildSqlParams(request, data);
  return request.query(`INSERT INTO ${table} (${columns}) VALUES (${values}); SELECT SCOPE_IDENTITY() AS id;`);
};

const updateCatalogItem = async (table, idColumn, id, data) => {
  const fields = Object.keys(data);
  const updates = fields.map((field, index) => `[${field}] = @p${index}`).join(", ");
  const request = pool.request();
  buildSqlParams(request, data);
  request.input("id", sql.Int, id);
  return request.query(`UPDATE ${table} SET ${updates} WHERE ${idColumn} = @id; SELECT @@ROWCOUNT AS affected;`);
};

const deleteCatalogItem = async (table, idColumn, id) => {
  return pool
    .request()
    .input("id", sql.Int, id)
    .query(`
      IF EXISTS(SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = 'Activo')
        UPDATE ${table} SET Activo = 0 WHERE ${idColumn} = @id;
      ELSE
        DELETE FROM ${table} WHERE ${idColumn} = @id;
      SELECT @@ROWCOUNT AS affected;
    `);
};

const simplifyValue = (value) => {
  if (value && typeof value === "object") {
    if ("id" in value) return value.id;
    if ("value" in value) return value.value;
  }
  return value;
};

const normalizeProviderPayload = (data) => {
  const normalized = { ...data };
  if ("Email" in normalized) { normalized.Correo = simplifyValue(normalized.Email); delete normalized.Email; }
  if ("Phone" in normalized) { normalized.Telefono = simplifyValue(normalized.Phone); delete normalized.Phone; }
  if ("Contact" in normalized) { normalized.Contacto = simplifyValue(normalized.Contact); delete normalized.Contact; }
  if ("Name" in normalized) { normalized.Nombre = simplifyValue(normalized.Name); delete normalized.Name; }
  return normalized;
};

const tableSchemas = {
  OrdenesCompra: {
    folio: "Folio", unidadnegocioid: "UnidadNegocioId",
    proveedorid: "ProveedorId", fecha: "Fecha", tipo: "Tipo",
    observaciones: "Observaciones", subtotal: "Subtotal", iva: "Iva", total: "Total",
    creador: "Creador", rechazado: "Rechazado", rechazadopor: "RechazadoPor",
    fecharechazo: "FechaRechazo", motivorechazo: "MotivoRechazo",
    modificadopor: "ModificadoPor", fechamodificacion: "FechaModificacion",
  },
  OrdenesCompraLineas: {
    cantidad: "Cantidad", descripcion: "Descripcion", unidadmedida: "UnidadMedida",
    preciounitario: "PrecioUnitario", total: "Total", ordenlinea: "OrdenLinea",
    ordencompralid: "OrdenCompraId", ordencompraid: "OrdenCompraId",
  },
  OrdenesCompraAprobaciones: {
    paso: "Paso", step: "Paso",
    etiqueta: "Etiqueta", label: "Etiqueta",
    aprobado: "Aprobado", aprobadopor: "AprobadoPor",
    fechaaprobacion: "FechaAprobacion", fecha: "FechaAprobacion",
    comentarios: "Comentarios",
    ordencompralid: "OrdenCompraId", ordencompraid: "OrdenCompraId",
  },
};

const normalizeRecord = (data, tableName) => {
  const schema = tableSchemas[tableName];
  if (!schema) return { ...data };
  const normalized = {};
  for (const [key, value] of Object.entries(data)) {
    const mappedKey = schema[key.toLowerCase()];
    if (mappedKey) normalized[mappedKey] = simplifyValue(value);
  }
  return normalized;
};

const insertCatalogItemInTransaction = async (transaction, table, data) => {
  const fields = Object.keys(data);
  const columns = fields.map((field) => `[${field}]`).join(", ");
  const values = fields.map((_, index) => `@p${index}`).join(", ");
  const request = new sql.Request(transaction);
  buildSqlParams(request, data);
  const result = await request.query(`INSERT INTO ${table} (${columns}) VALUES (${values}); SELECT SCOPE_IDENTITY() AS id;`);
  return result.recordset[0].id;
};

const insertOrderWithDetails = async (data) => {
  const rawOrderData = { ...data };
  const lineItems = rawOrderData.LineItems || rawOrderData.lineItems || [];
  const approvals = rawOrderData.Aprobaciones || rawOrderData.aprobaciones || [];
  delete rawOrderData.LineItems; delete rawOrderData.lineItems;
  delete rawOrderData.Aprobaciones; delete rawOrderData.aprobaciones;

  const orderData = normalizeRecord(rawOrderData, "OrdenesCompra");
  if (!orderData.Folio) orderData.Folio = await generateOrderFolio();

  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const orderId = await insertCatalogItemInTransaction(transaction, "OrdenesCompra", orderData);
    for (const item of lineItems) {
      await insertCatalogItemInTransaction(transaction, "OrdenesCompraLineas", normalizeRecord({ ...item, OrdenCompraId: orderId }, "OrdenesCompraLineas"));
    }
    for (const approval of approvals) {
      await insertCatalogItemInTransaction(transaction, "OrdenesCompraAprobaciones", normalizeRecord({ ...approval, OrdenCompraId: orderId }, "OrdenesCompraAprobaciones"));
    }
    await transaction.commit();
    return orderId;
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
};

const generateOrderFolio = async () => {
  const result = await pool.request().query(`SELECT COUNT(*) AS Total FROM OrdenesCompra`);
  const nextNumber = (result.recordset[0]?.Total || 0) + 1;
  return `OC-${String(nextNumber).padStart(6, "0")}`;
};

// ─── Middleware JWT ───────────────────────────────────────────────────────────
function autenticar(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No autorizado" });
  }
  try {
    req.usuario = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido o expirado" });
  }
}

function soloAdmin(req, res, next) {
  if (!req.usuario || req.usuario.rol !== "admin") {
    return res.status(403).json({ error: "Acceso solo para administradores" });
  }
  next();
}

// TEST
app.get("/", (req, res) => res.send("API funcionando"));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { correo, password } = req.body;
    if (!correo || !password) return res.status(400).json({ error: "Correo y contraseña requeridos" });

    const result = await pool.request()
      .input("Correo", sql.NVarChar(150), correo.toLowerCase().trim())
      .query("SELECT * FROM dbo.Usuarios WHERE Correo = @Correo AND Activo = 1");

    const user = result.recordset[0];
    if (!user) return res.status(401).json({ error: "Credenciales inválidas" });

    const valid = await bcrypt.compare(password, user.PasswordHash);
    if (!valid) return res.status(401).json({ error: "Credenciales inválidas" });

    await pool.request()
      .input("id", sql.Int, user.UsuarioId)
      .query("UPDATE dbo.Usuarios SET UltimoAcceso = SYSUTCDATETIME() WHERE UsuarioId = @id");

    const token = jwt.sign(
      { id: user.UsuarioId, correo: user.Correo, nombre: user.Nombre, rol: user.Rol },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      usuario: {
        id: user.UsuarioId,
        correo: user.Correo,
        nombre: user.Nombre,
        rol: user.Rol,
        debeReiniciarPass: Boolean(user.DebeReiniciarPass),
      },
    });
  } catch (err) {
    console.log("❌ LOGIN:", err);
    res.status(500).json({ error: "Error al iniciar sesión" });
  }
});

app.post("/api/auth/cambiar-password", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) return res.status(401).json({ error: "No autorizado" });
    let decoded;
    try { decoded = jwt.verify(auth.slice(7), JWT_SECRET); }
    catch { return res.status(401).json({ error: "Token inválido o expirado" }); }

    const { passwordActual, passwordNuevo } = req.body;
    if (!passwordActual || !passwordNuevo) return res.status(400).json({ error: "Faltan contraseñas" });
    if (passwordNuevo.length < 6) return res.status(400).json({ error: "Mínimo 6 caracteres" });

    const result = await pool.request()
      .input("id", sql.Int, decoded.id)
      .query("SELECT PasswordHash FROM dbo.Usuarios WHERE UsuarioId = @id AND Activo = 1");

    const user = result.recordset[0];
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    const valid = await bcrypt.compare(passwordActual, user.PasswordHash);
    if (!valid) return res.status(400).json({ error: "La contraseña actual no es correcta" });

    const newHash = await bcrypt.hash(passwordNuevo, 10);
    await pool.request()
      .input("id", sql.Int, decoded.id)
      .input("hash", sql.NVarChar(255), newHash)
      .query("UPDATE dbo.Usuarios SET PasswordHash = @hash, DebeReiniciarPass = 0 WHERE UsuarioId = @id");

    res.json({ ok: true });
  } catch (err) {
    console.log("❌ CAMBIAR PASSWORD:", err);
    res.status(500).json({ error: "Error al cambiar contraseña" });
  }
});

app.post("/api/auth/recuperar", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { correo } = req.body;
    if (!correo) return res.status(400).json({ error: "Correo requerido" });

    const result = await pool.request()
      .input("Correo", sql.NVarChar(150), correo.toLowerCase().trim())
      .query("SELECT UsuarioId FROM dbo.Usuarios WHERE Correo = @Correo AND Activo = 1");

    if (!result.recordset[0]) return res.json({ ok: true });

    const uid = result.recordset[0].UsuarioId;
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    const expiracion = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await pool.request()
      .input("uid", sql.Int, uid)
      .query("UPDATE dbo.TokensRecuperacion SET Usado = 1 WHERE UsuarioId = @uid AND Usado = 0");

    await pool.request()
      .input("uid", sql.Int, uid)
      .input("token", sql.NVarChar(20), code)
      .input("exp", sql.DateTime2, expiracion)
      .query("INSERT INTO dbo.TokensRecuperacion (UsuarioId, Token, Expiracion) VALUES (@uid, @token, @exp)");

    console.log(`Código recuperación para ${correo}: ${code}`);
    res.json({ ok: true, codigo: code });
  } catch (err) {
    console.log("❌ RECUPERAR:", err);
    res.status(500).json({ error: "Error al procesar solicitud" });
  }
});

app.post("/api/auth/restablecer", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { correo, codigo, passwordNuevo } = req.body;
    if (!correo || !codigo || !passwordNuevo) return res.status(400).json({ error: "Faltan campos" });
    if (passwordNuevo.length < 6) return res.status(400).json({ error: "Mínimo 6 caracteres" });

    const result = await pool.request()
      .input("correo", sql.NVarChar(150), correo.toLowerCase().trim())
      .input("token", sql.NVarChar(20), codigo.toUpperCase().trim())
      .query(`
        SELECT u.UsuarioId, t.TokenId
        FROM dbo.Usuarios u
        JOIN dbo.TokensRecuperacion t ON t.UsuarioId = u.UsuarioId
        WHERE u.Correo = @correo AND t.Token = @token
          AND t.Usado = 0 AND t.Expiracion > SYSUTCDATETIME() AND u.Activo = 1
      `);

    if (!result.recordset[0]) return res.status(400).json({ error: "Código inválido o expirado" });

    const { UsuarioId, TokenId } = result.recordset[0];
    const newHash = await bcrypt.hash(passwordNuevo, 10);

    await pool.request()
      .input("id", sql.Int, UsuarioId)
      .input("hash", sql.NVarChar(255), newHash)
      .query("UPDATE dbo.Usuarios SET PasswordHash = @hash, DebeReiniciarPass = 0 WHERE UsuarioId = @id");

    await pool.request()
      .input("tid", sql.Int, TokenId)
      .query("UPDATE dbo.TokensRecuperacion SET Usado = 1 WHERE TokenId = @tid");

    res.json({ ok: true });
  } catch (err) {
    console.log("❌ RESTABLECER:", err);
    res.status(500).json({ error: "Error al restablecer contraseña" });
  }
});

// ─── USUARIOS (solo admin) ────────────────────────────────────────────────────
app.get("/api/usuarios", autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await pool.request().query(
      "SELECT UsuarioId, Correo, Nombre, Rol, DebeReiniciarPass, Activo, FechaCreacion, UltimoAcceso FROM dbo.Usuarios ORDER BY Nombre"
    );
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: "Error al listar usuarios" });
  }
});

app.post("/api/usuarios", autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { correo, nombre, rol, passwordInicial } = req.body;
    if (!correo || !nombre) return res.status(400).json({ error: "Correo y nombre requeridos" });

    const hash = await bcrypt.hash(passwordInicial || "Udat2024!", 10);
    const result = await pool.request()
      .input("Correo", sql.NVarChar(150), correo.toLowerCase().trim())
      .input("Hash", sql.NVarChar(255), hash)
      .input("Nombre", sql.NVarChar(200), nombre.trim())
      .input("Rol", sql.NVarChar(50), rol || "empleado")
      .query(`INSERT INTO dbo.Usuarios (Correo, PasswordHash, Nombre, Rol, DebeReiniciarPass)
              OUTPUT INSERTED.UsuarioId VALUES (@Correo, @Hash, @Nombre, @Rol, 1)`);

    res.status(201).json({ id: result.recordset[0].UsuarioId });
  } catch (err) {
    if (err.number === 2627 || err.number === 2601)
      return res.status(400).json({ error: "Ya existe un usuario con ese correo" });
    res.status(500).json({ error: "Error al crear usuario" });
  }
});

app.put("/api/usuarios/:id", autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { nombre, rol, activo } = req.body;
    await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .input("Nombre", sql.NVarChar(200), nombre)
      .input("Rol", sql.NVarChar(50), rol)
      .input("Activo", sql.Bit, activo !== false ? 1 : 0)
      .query("UPDATE dbo.Usuarios SET Nombre = @Nombre, Rol = @Rol, Activo = @Activo WHERE UsuarioId = @id");
    res.sendStatus(204);
  } catch (err) {
    res.status(500).json({ error: "Error al actualizar usuario" });
  }
});

app.post("/api/usuarios/:id/resetear", autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const temp = req.body.password || "Udat2024!";
    const hash = await bcrypt.hash(temp, 10);
    await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .input("hash", sql.NVarChar(255), hash)
      .query("UPDATE dbo.Usuarios SET PasswordHash = @hash, DebeReiniciarPass = 1 WHERE UsuarioId = @id");
    res.json({ ok: true, passwordTemporal: temp });
  } catch (err) {
    res.status(500).json({ error: "Error al resetear contraseña" });
  }
});

// ─── CATÁLOGOS ────────────────────────────────────────────────────────────────
app.get("/api/catalogos/cursos", async (req, res) => {
  try {
    if (!pool) return res.status(500).send("No hay conexión SQL");
    const result = await pool.request().query(`SELECT * FROM Cursos WHERE Activo = 1 ORDER BY Nombre`);
    res.json(result.recordset.map((r) => ({ ...r, TipoCosto: r.TipoCosto == null ? "" : r.TipoCosto })));
  } catch (err) { console.log("❌ ERROR CURSOS:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/cursos", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("Cursos", req.body);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR CURSO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/cursos/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("Cursos", "CursoId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Curso no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR CURSO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/cursos/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("Cursos", "CursoId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Curso no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR CURSO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/clientes", async (req, res) => {
  try {
    const result = await pool.request().query(`SELECT EmpresaId AS ClienteId, Nombre FROM Empresas WHERE Activo = 1 ORDER BY Nombre`);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR EMPRESAS:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/clientes", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("Empresas", req.body);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR CLIENTE:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/clientes/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("Empresas", "EmpresaId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Cliente no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR CLIENTE:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/clientes/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("Empresas", "EmpresaId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Cliente no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR CLIENTE:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/coaches", async (req, res) => {
  try {
    const result = await pool.request().query(`SELECT CoachId, Nombre FROM Coaches WHERE Activo = 1 ORDER BY Nombre`);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR COACHES:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/coaches", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("Coaches", req.body);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR COACH:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/coaches/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("Coaches", "CoachId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Coach no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR COACH:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/coaches/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("Coaches", "CoachId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Coach no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR COACH:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/modalidades", async (req, res) => {
  try {
    const result = await pool.request().query(`SELECT * FROM Modalidades ORDER BY Nombre`);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR MODALIDADES:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/modalidades", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("Modalidades", req.body);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR MODALIDAD:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/modalidades/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("Modalidades", "ModalidadId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Modalidad no encontrada");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR MODALIDAD:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/modalidades/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("Modalidades", "ModalidadId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Modalidad no encontrada");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR MODALIDAD:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/conceptos", async (req, res) => {
  try {
    const result = await pool.request().query(`SELECT * FROM ConceptosCosto WHERE Activo = 1 ORDER BY Nombre`);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR CONCEPTOS:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/conceptos", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("ConceptosCosto", req.body);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR CONCEPTO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/conceptos/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("ConceptosCosto", "ConceptoCostoId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Concepto no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR CONCEPTO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/conceptos/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("ConceptosCosto", "ConceptoCostoId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Concepto no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR CONCEPTO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/proveedores", async (req, res) => {
  try {
    const result = await pool.request().query(`SELECT * FROM Proveedores WHERE Activo = 1 ORDER BY Nombre`);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR PROVEEDORES:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/proveedores", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("Proveedores", normalizeProviderPayload(req.body));
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR PROVEEDOR:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/proveedores/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("Proveedores", "ProveedorId", req.params.id, normalizeProviderPayload(req.body));
    if (result.recordset[0].affected === 0) return res.status(404).send("Proveedor no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR PROVEEDOR:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/proveedores/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("Proveedores", "ProveedorId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Proveedor no encontrado");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR PROVEEDOR:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/unidadesnegocio", async (req, res) => {
  try {
    const result = await pool.request().query(`SELECT * FROM UnidadesNegocio WHERE Activo = 1 ORDER BY Nombre`);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR UNIDADES DE NEGOCIO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/catalogos/unidadesnegocio", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await insertCatalogItem("UnidadesNegocio", req.body);
    res.status(201).json({ id: result.recordset[0].id });
  } catch (err) { console.log("❌ ERROR CREAR UNIDAD DE NEGOCIO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/catalogos/unidadesnegocio/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("UnidadesNegocio", "UnidadNegocioId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Unidad de negocio no encontrada");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR UNIDAD DE NEGOCIO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.delete("/api/catalogos/unidadesnegocio/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await deleteCatalogItem("UnidadesNegocio", "UnidadNegocioId", req.params.id);
    if (result.recordset[0].affected === 0) return res.status(404).send("Unidad de negocio no encontrada");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR UNIDAD DE NEGOCIO:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/participantes", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const search = (req.query.search || '').trim();
    if (!search || search.length < 2) {
      return res.json([]);
    }
    const result = await pool.request()
      .input("search", sql.NVarChar(200), `%${search}%`)
      .input("searchNum", sql.NVarChar(200), `${search}%`)
      .query(`
        SELECT TOP 50
          NumeroEmpleado AS EmpleadoId,
          NumeroEmpleado,
          LTRIM(RTRIM(
            ISNULL(Nombre,'') + ' ' +
            ISNULL(ApellidoPaterno,'') + ' ' +
            ISNULL(ApellidoMaterno,'')
          )) AS NombreCompleto,
          ISNULL(Empresa,'') AS Empresa,
          ISNULL(UnidadNegocio,'') AS UnidadNegocio
        FROM [biUDAT].[STG].[tPlantillaColaboradoresTrayecto]
        WHERE BActivo = 1
          AND (
            LTRIM(RTRIM(
              ISNULL(Nombre,'') + ' ' +
              ISNULL(ApellidoPaterno,'') + ' ' +
              ISNULL(ApellidoMaterno,'')
            )) LIKE @search
            OR CAST(NumeroEmpleado AS NVARCHAR(50)) LIKE @searchNum
          )
        ORDER BY Nombre, ApellidoPaterno
      `);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR PARTICIPANTES:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/catalogos/estados", async (req, res) => {
  res.json([
    { Id: 1, Nombre: "Borrador" },
    { Id: 2, Nombre: "Enviado" },
    { Id: 3, Nombre: "Aprobado" },
    { Id: 4, Nombre: "Rechazado" },
  ]);
});

// ─── COTIZACIONES ─────────────────────────────────────────────────────────────
app.get("/api/cotizaciones/generate/folio", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query("SELECT COUNT(*) AS Total FROM Cotizaciones");
    const n = (r.recordset[0]?.Total || 0) + 1;
    res.json({ folio: `COT-${String(n).padStart(6, "0")}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/cotizaciones", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const soloMias = req.usuario.rol === 'empleado';
    const request = pool.request();
    if (soloMias) request.input("nombre", sql.NVarChar(150), req.usuario.nombre);
    const result = await request.query(`
      SELECT c.*,
        cl.Nombre AS Cliente,
        cu.Nombre AS Curso,
        co.Nombre AS Coach,
        m.Nombre AS Modalidad
      FROM Cotizaciones c
      LEFT JOIN Empresas cl    ON c.ClienteId   = cl.EmpresaId
      LEFT JOIN Cursos cu      ON c.CursoId     = cu.CursoId
      LEFT JOIN Coaches co     ON c.CoachId     = co.CoachId
      LEFT JOIN Modalidades m  ON c.ModalidadId = m.ModalidadId
      ${soloMias ? "WHERE c.CreadoPor = @nombre" : ""}
      ORDER BY c.FechaCreacion DESC, c.CotizacionId DESC
    `);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR COTIZACIONES:", err); res.status(500).json({ error: err.message }); }
});

app.get("/api/cotizaciones/pendientes/list", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await pool.request().query(`
      SELECT c.*,
        cl.Nombre AS Cliente,
        cu.Nombre AS Curso,
        co.Nombre AS Coach
      FROM Cotizaciones c
      LEFT JOIN Empresas cl ON c.ClienteId = cl.EmpresaId
      LEFT JOIN Cursos cu   ON c.CursoId   = cu.CursoId
      LEFT JOIN Coaches co  ON c.CoachId   = co.CoachId
      WHERE c.Estado = 'Pendiente'
      ORDER BY c.FechaCreacion DESC
    `);
    res.json(result.recordset);
  } catch (err) { console.log("❌ ERROR COTIZACIONES PENDIENTES:", err); res.status(500).json({ error: err.message }); }
});

app.get("/api/cotizaciones/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const cotRes = await pool.request().input("id", sql.Int, id).query(`
      SELECT c.*,
        cl.Nombre AS Cliente, cu.Nombre AS Curso,
        co.Nombre AS Coach,  m.Nombre  AS Modalidad
      FROM Cotizaciones c
      LEFT JOIN Empresas cl   ON c.ClienteId   = cl.EmpresaId
      LEFT JOIN Cursos cu     ON c.CursoId     = cu.CursoId
      LEFT JOIN Coaches co    ON c.CoachId     = co.CoachId
      LEFT JOIN Modalidades m ON c.ModalidadId = m.ModalidadId
      WHERE c.CotizacionId = @id`);
    if (!cotRes.recordset.length) return res.status(404).send("Cotización no encontrada");

    const partRes = await pool.request().input("id", sql.Int, id)
      .query("SELECT * FROM CotizacionParticipantes WHERE CotizacionId = @id");

    let costos = [];
    try {
      const costosRes = await pool.request().input("id", sql.Int, id)
        .query("SELECT * FROM CotizacionCostos WHERE CotizacionId = @id ORDER BY Orden");
      costos = costosRes.recordset;
    } catch (_) { /* tabla de costos opcional */ }

    res.json({ cotizacion: cotRes.recordset[0], costos, participantes: partRes.recordset });
  } catch (err) { console.log("❌ ERROR COTIZACION POR ID:", err); res.status(500).json({ error: err.message }); }
});

app.post("/api/cotizaciones", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    const costos       = d.costos       || [];
    const participantes= d.participantes|| [];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      // Detectar columnas opcionales: EstadoId/Estado, FKs, columnas de margen desglosado
      const schemaCheck = await new sql.Request(transaction).query(`
        SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME='Cotizaciones' AND COLUMN_NAME IN (
          'EstadoId','Estado','ClienteId','CursoId','CoachId','ModalidadId',
          'MargenUtilidadPctDirectos','MargenUtilidadDirectos',
          'MargenUtilidadPctIndirectos','MargenUtilidadIndirectos'
        )
      `);
      const existingCols = new Set(schemaCheck.recordset.map(r => r.COLUMN_NAME));

      const req1 = new sql.Request(transaction);
      const cols = [
        "Folio","DuracionDias","SesionesPorDia","ParticipantesCantidad",
        "FechaInicio","FechaFin","Observaciones",
        "TotalCostosDirectos","TotalCostosIndirectos","TotalCostos",
        "MargenUtilidadPct","MargenUtilidad","TotalConGanancia",
        "PrecioPorParticipante","PrecioSugeridoPorParticipante","CreadoPor",
        "FechaCreacion",
      ];
      req1
        .input("Folio",                          sql.NVarChar(50),      d.folio || "COT-000000")
        .input("DuracionDias",                   sql.Int,               d.duracionDias          || null)
        .input("SesionesPorDia",                 sql.Int,               d.sesionesPorDia        || null)
        .input("ParticipantesCantidad",          sql.Int,               d.participantesCantidad || null)
        .input("FechaInicio",                    sql.Date,              d.fechaInicio           || null)
        .input("FechaFin",                       sql.Date,              d.fechaFin              || null)
        .input("Observaciones",                  sql.NVarChar(sql.MAX), d.observaciones         || null)
        .input("TotalCostosDirectos",            sql.Decimal(18,2),     d.totalCostosDirectos   || 0)
        .input("TotalCostosIndirectos",          sql.Decimal(18,2),     d.totalCostosIndirectos || 0)
        .input("TotalCostos",                    sql.Decimal(18,2),     d.totalCostos           || 0)
        .input("MargenUtilidadPct",              sql.Decimal(18,4),     d.margenUtilidadPct     || 0)
        .input("MargenUtilidad",                 sql.Decimal(18,2),     d.margenUtilidad        || 0)
        .input("TotalConGanancia",               sql.Decimal(18,2),     d.totalConGanancia      || 0)
        .input("PrecioPorParticipante",          sql.Decimal(18,2),     d.precioPorParticipante || 0)
        .input("PrecioSugeridoPorParticipante",  sql.Decimal(18,2),     d.precioSugeridoPorParticipante || 0)
        .input("CreadoPor",                      sql.NVarChar(150),     d.creadoPor || null)
        .input("FechaCreacion",                  sql.DateTime2,         new Date());

      // Columnas de margen desglosado: solo si existen en la tabla
      if (existingCols.has("MargenUtilidadPctDirectos")) {
        cols.push("MargenUtilidadPctDirectos");
        req1.input("MargenUtilidadPctDirectos", sql.Decimal(18,4), d.margenUtilidadPctDirectos ?? null);
      }
      if (existingCols.has("MargenUtilidadDirectos")) {
        cols.push("MargenUtilidadDirectos");
        req1.input("MargenUtilidadDirectos", sql.Decimal(18,2), d.margenUtilidadDirectos ?? null);
      }
      if (existingCols.has("MargenUtilidadPctIndirectos")) {
        cols.push("MargenUtilidadPctIndirectos");
        req1.input("MargenUtilidadPctIndirectos", sql.Decimal(18,4), d.margenUtilidadPctIndirectos ?? null);
      }
      if (existingCols.has("MargenUtilidadIndirectos")) {
        cols.push("MargenUtilidadIndirectos");
        req1.input("MargenUtilidadIndirectos", sql.Decimal(18,2), d.margenUtilidadIndirectos ?? null);
      }

      // Estado: siempre "Pendiente" al crear — el flujo de aprobación lo cambia
      if (existingCols.has("EstadoId")) {
        cols.push("EstadoId");
        req1.input("EstadoId", sql.Int, 1);
      } else if (existingCols.has("Estado")) {
        cols.push("Estado");
        req1.input("Estado", sql.NVarChar(50), "Pendiente");
      }

      // FK opcionales: solo incluir si el campo fue enviado (evita NOT NULL violation)
      if (d.clienteId  && existingCols.has("ClienteId"))  { cols.push("ClienteId");   req1.input("ClienteId",   sql.Int, Number(d.clienteId));   }
      if (d.cursoId    && existingCols.has("CursoId"))    { cols.push("CursoId");     req1.input("CursoId",     sql.Int, Number(d.cursoId));     }
      if (d.coachId    && existingCols.has("CoachId"))    { cols.push("CoachId");     req1.input("CoachId",     sql.Int, Number(d.coachId));     }
      if (d.modalidadId&& existingCols.has("ModalidadId")){ cols.push("ModalidadId"); req1.input("ModalidadId", sql.Int, Number(d.modalidadId)); }

      const vals = cols.map(c => `@${c}`);
      const result = await req1.query(
        `INSERT INTO Cotizaciones (${cols.join(",")}) VALUES (${vals.join(",")});
         SELECT SCOPE_IDENTITY() AS id;`
      );

      const cotizacionId = result.recordset[0].id;

      for (const p of participantes) {
        await new sql.Request(transaction)
          .input("CotizacionId",   sql.Int,               cotizacionId)
          .input("EmpleadoId",     sql.Int,               p.empleadoId     || null)
          .input("NombreCompleto", sql.NVarChar(300),     p.nombreCompleto || null)
          .input("Empresa",        sql.NVarChar(200),     p.empresa        || null)
          .input("Factura2",       sql.NVarChar(200),     p.factura2       || null)
          .input("Factura3",       sql.NVarChar(200),     p.factura3       || null)
          .input("Observaciones",  sql.NVarChar(sql.MAX), p.observaciones  || null)
          .query(`INSERT INTO CotizacionParticipantes
            (CotizacionId,EmpleadoId,NombreCompleto,Empresa,Factura2,Factura3,Observaciones)
            VALUES(@CotizacionId,@EmpleadoId,@NombreCompleto,@Empresa,@Factura2,@Factura3,@Observaciones)`);
      }

      await transaction.commit();

      // Costos: intento separado, no afecta el guardado principal si falla
      for (let i = 0; i < costos.length; i++) {
        const c = costos[i];
        try {
          await pool.request()
            .input("CotizacionId",  sql.Int,           cotizacionId)
            .input("Concepto",      sql.NVarChar(200),  c.concepto    || null)
            .input("TipoCalculo",   sql.NVarChar(100),  c.tipoCalculo || null)
            .input("Formula",       sql.NVarChar(200),  c.formula     || null)
            .input("TipoCosto",     sql.NVarChar(100),  c.tipoCosto   || null)
            .input("CostoUnitario", sql.Decimal(18,2),  Number(c.costoUnitario) || 0)
            .input("Cantidad",      sql.NVarChar(50),   String(c.cantidad ?? ""))
            .input("Total",         sql.Decimal(18,2),  Number(c.total) || 0)
            .input("Orden",         sql.Int,            c.orden || i + 1)
            .query(`INSERT INTO CotizacionCostos
              (CotizacionId,Concepto,TipoCalculo,Formula,TipoCosto,CostoUnitario,Cantidad,Total,Orden)
              VALUES(@CotizacionId,@Concepto,@TipoCalculo,@Formula,@TipoCosto,@CostoUnitario,@Cantidad,@Total,@Orden)`);
        } catch (costErr) {
          console.log("⚠️ No se guardaron costos (tabla CotizacionCostos):", costErr.message);
        }
      }

      res.status(201).json({ cotizacionId, id: cotizacionId });

      // Notificar por correo al autorizador1 (sin bloquear la respuesta)
      getEmailsDeRol("autorizador1").then(emails => {
        if (emails.length) {
          console.log(`📧 Notificando cotización ${d.folio} a autorizador1 (${emails.length} usuario(s))`);
          sendMail(
            emails,
            `Nueva cotización ${d.folio} requiere su aprobación`,
            emailCotizacionPendiente(d.folio, null, null, d.totalConGanancia, d.creadoPor)
          );
        }
      }).catch(() => {});
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) { console.log("❌ ERROR CREAR COTIZACIÓN:", err); res.status(500).json({ error: err.message }); }
});

app.delete("/api/cotizaciones/:id", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const t = new sql.Transaction(pool);
    await t.begin();
    try {
      await new sql.Request(t).input("id", sql.Int, id).query("DELETE FROM CotizacionParticipantes WHERE CotizacionId=@id");
      try { await new sql.Request(t).input("id", sql.Int, id).query("DELETE FROM CotizacionCostos WHERE CotizacionId=@id"); } catch (_) {}
      const r = await new sql.Request(t).input("id", sql.Int, id).query("DELETE FROM Cotizaciones WHERE CotizacionId=@id");
      await t.commit();
      if (r.rowsAffected[0] === 0) return res.status(404).json({ error: "Cotización no encontrada" });
      res.sendStatus(204);
    } catch (err) { await t.rollback(); throw err; }
  } catch (err) { console.log("❌ ERROR ELIMINAR COTIZACIÓN:", err); res.status(500).json({ error: err.message }); }
});

app.put("/api/cotizaciones/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body, id = Number(req.params.id);
    await pool.request()
      .input("id",     sql.Int,           id)
      .input("Estado", sql.NVarChar(50),  d.estado || "Borrador")
      .query("UPDATE Cotizaciones SET Estado = @Estado WHERE CotizacionId = @id");
    res.sendStatus(204);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/cotizaciones/:id/enviar", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .query("UPDATE Cotizaciones SET Estado = 'Enviada' WHERE CotizacionId = @id");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/cotizaciones/:id/aprobar", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { rol, nombre } = req.usuario;
    if (rol !== 'autorizador1' && rol !== 'admin') {
      return res.status(403).json({ error: "Solo el autorizador 1 puede aprobar cotizaciones" });
    }
    const { aprobado, comentarios } = req.body;
    const estado = aprobado ? "Aprobada" : "Rechazada";
    const cotRes = await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .query(`SELECT c.Folio, c.TotalConGanancia, c.CreadoPor,
                cl.Nombre AS Cliente, cu.Nombre AS Curso
              FROM Cotizaciones c
              LEFT JOIN Empresas cl ON c.ClienteId = cl.EmpresaId
              LEFT JOIN Cursos cu   ON c.CursoId   = cu.CursoId
              WHERE c.CotizacionId = @id`);
    await pool.request()
      .input("id",           sql.Int,            Number(req.params.id))
      .input("Estado",       sql.NVarChar(50),   estado)
      .input("AprobadoPor",  sql.NVarChar(150),  nombre || null)
      .input("FechaAprobacion", sql.DateTime2,   new Date())
      .input("Comentarios",  sql.NVarChar(1000), comentarios || null)
      .query(`UPDATE Cotizaciones
              SET Estado=@Estado, AprobadoPor=@AprobadoPor,
                  FechaAprobacion=@FechaAprobacion, ComentariosAprobacion=@Comentarios
              WHERE CotizacionId=@id`);
    res.json({ ok: true });

    // Notificar al creador del resultado (sin bloquear la respuesta)
    const cot = cotRes.recordset[0];
    if (cot) {
      getEmailDeUsuario(cot.CreadoPor).then(emails => {
        if (emails.length) {
          console.log(`📧 Notificando resultado cotización ${cot.Folio} a ${cot.CreadoPor}`);
          sendMail(
            emails,
            `Tu cotización ${cot.Folio} fue ${estado.toLowerCase()}`,
            emailCotizacionResuelta(cot.Folio, cot.Cliente, cot.Curso, cot.TotalConGanancia, estado, comentarios, nombre)
          );
        }
      }).catch(() => {});
    }
  } catch (err) { console.log("❌ ERROR APROBAR COTIZACIÓN:", err); res.status(500).json({ error: err.message }); }
});

// ─── ORDENES DE COMPRA ────────────────────────────────────────────────────────
app.get("/api/ordenescompra", autenticar, async (req, res) => {
  try {
    const soloMias = req.usuario.rol === 'empleado';
    const reqOrd = pool.request();
    if (soloMias) reqOrd.input("nombre", sql.NVarChar(150), req.usuario.nombre);
    const [ordResult, aprobResult] = await Promise.all([
      reqOrd.query(`
        SELECT oc.*, u.Nombre AS UnidadNegocio, p.Nombre AS Proveedor
        FROM OrdenesCompra oc
        INNER JOIN UnidadesNegocio u ON oc.UnidadNegocioId = u.UnidadNegocioId
        INNER JOIN Proveedores p ON oc.ProveedorId = p.ProveedorId
        ${soloMias ? "WHERE oc.CreadoPor = @nombre" : ""}
        ORDER BY oc.Fecha DESC, oc.OrdenCompraId DESC
      `),
      pool.request().query(`
        SELECT OrdenCompraId, Paso, Etiqueta, Aprobado, AprobadoPor, FechaAprobacion
        FROM OrdenesCompraAprobaciones ORDER BY OrdenCompraId, Paso
      `),
    ]);
    const aprobMap = {};
    for (const r of aprobResult.recordset) {
      if (!aprobMap[r.OrdenCompraId]) aprobMap[r.OrdenCompraId] = [];
      aprobMap[r.OrdenCompraId].push({
        step: r.Paso, label: r.Etiqueta,
        aprobado: Boolean(r.Aprobado), aprobadoPor: r.AprobadoPor, fecha: r.FechaAprobacion,
      });
    }
    res.json(ordResult.recordset.map((o) => ({ ...o, Aprobaciones: aprobMap[o.OrdenCompraId] || [] })));
  } catch (err) { console.log("❌ ERROR ORDENES DE COMPRA:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.get("/api/ordenescompra/:id", async (req, res) => {
  try {
    const orderResult = await pool.request().input("id", sql.Int, req.params.id).query(`
      SELECT oc.*, u.Nombre AS UnidadNegocio, p.Nombre AS Proveedor
      FROM OrdenesCompra oc
      INNER JOIN UnidadesNegocio u ON oc.UnidadNegocioId = u.UnidadNegocioId
      INNER JOIN Proveedores p ON oc.ProveedorId = p.ProveedorId
      WHERE oc.OrdenCompraId = @id
    `);
    if (!orderResult.recordset.length) return res.status(404).send("Orden de compra no encontrada");
    const lineas = await pool.request().input("id", sql.Int, req.params.id).query(`SELECT * FROM OrdenesCompraLineas WHERE OrdenCompraId = @id ORDER BY OrdenLinea, OrdenCompraLineaId`);
    const aprobaciones = await pool.request().input("id", sql.Int, req.params.id).query(`SELECT * FROM OrdenesCompraAprobaciones WHERE OrdenCompraId = @id ORDER BY Paso`);
    res.json({ ...orderResult.recordset[0], Lineas: lineas.recordset, Aprobaciones: aprobaciones.recordset });
  } catch (err) { console.log("❌ ERROR ORDEN DE COMPRA POR ID:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.post("/api/ordenescompra", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = await insertOrderWithDetails(req.body);
    const folio    = req.body.Folio || req.body.folio || "";
    const proveedor= req.body.Proveedor || req.body.proveedor || "";
    const total    = req.body.Total || req.body.total || 0;
    // Notificación async (no bloquea la respuesta)
    getEmailsDeRol("autorizador1").then((emails) => {
      console.log(`📧 Notificando orden ${folio} a autorizador1 (${emails.length} usuario(s)): [${emails.join(", ")}]`);
      sendMail(emails, `Nueva orden ${folio} requiere su autorización`, emailOrdenCreada(folio, proveedor, total));
    });
    res.status(201).json({ id: orderId });
  } catch (err) { console.log("❌ ERROR CREAR ORDEN DE COMPRA:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/ordenescompra/:id", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await updateCatalogItem("OrdenesCompra", "OrdenCompraId", req.params.id, req.body);
    if (result.recordset[0].affected === 0) return res.status(404).send("Orden de compra no encontrada");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR ORDEN DE COMPRA:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
app.get("/api/dashboard", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;

    const [statsRes, aprobRes, mesRes, provRes, unidadRes, recientesRes] = await Promise.all([
      // Totales generales
      pool.request().query(`
        SELECT
          COUNT(*) AS Total,
          SUM(CASE WHEN Rechazado=1 THEN 1 ELSE 0 END) AS Rechazadas,
          ISNULL(SUM(Total), 0) AS MontoTotal
        FROM OrdenesCompra
      `),
      // Estado de aprobaciones por orden
      pool.request().query(`
        SELECT oc.OrdenCompraId, oc.Rechazado,
          SUM(CASE WHEN oca.Aprobado=1 THEN 1 ELSE 0 END) AS PasosAprobados,
          COUNT(oca.OrdenCompraAprobacionId)              AS TotalPasos
        FROM OrdenesCompra oc
        LEFT JOIN OrdenesCompraAprobaciones oca ON oc.OrdenCompraId = oca.OrdenCompraId
        GROUP BY oc.OrdenCompraId, oc.Rechazado
      `),
      // Órdenes por mes (últimos 6 meses)
      pool.request().query(`
        SELECT FORMAT(FechaCreacion,'yyyy-MM') AS Mes,
               COUNT(*) AS Total,
               CAST(ISNULL(SUM(Total),0) AS DECIMAL(18,2)) AS Monto
        FROM OrdenesCompra
        WHERE FechaCreacion >= DATEADD(month,-6,GETDATE())
        GROUP BY FORMAT(FechaCreacion,'yyyy-MM')
        ORDER BY Mes
      `),
      // Top 5 proveedores por monto
      pool.request().query(`
        SELECT TOP 5 p.Nombre,
               COUNT(*) AS NumOrdenes,
               CAST(ISNULL(SUM(oc.Total),0) AS DECIMAL(18,2)) AS Monto
        FROM OrdenesCompra oc
        JOIN Proveedores p ON oc.ProveedorId = p.ProveedorId
        GROUP BY p.Nombre ORDER BY Monto DESC
      `),
      // Por unidad de negocio
      pool.request().query(`
        SELECT u.Nombre,
               COUNT(*) AS NumOrdenes,
               CAST(ISNULL(SUM(oc.Total),0) AS DECIMAL(18,2)) AS Monto
        FROM OrdenesCompra oc
        JOIN UnidadesNegocio u ON oc.UnidadNegocioId = u.UnidadNegocioId
        GROUP BY u.Nombre ORDER BY Monto DESC
      `),
      // Últimas 5 órdenes
      pool.request().query(`
        SELECT TOP 5 oc.Folio, oc.Total, oc.Rechazado, oc.FechaCreacion,
               p.Nombre AS Proveedor, oc.Creador
        FROM OrdenesCompra oc
        JOIN Proveedores p ON oc.ProveedorId = p.ProveedorId
        ORDER BY oc.FechaCreacion DESC
      `),
    ]);

    // Calcular pendientes por paso
    let pendientePaso1 = 0, pendientePaso2 = 0, aprobadas = 0;
    for (const r of aprobRes.recordset) {
      if (r.Rechazado) continue;
      if (r.PasosAprobados === 0)                               pendientePaso1++;
      else if (r.PasosAprobados === 1 && r.TotalPasos >= 2)     pendientePaso2++;
      else if (r.TotalPasos > 0 && r.PasosAprobados === r.TotalPasos) aprobadas++;
    }

    const stats = statsRes.recordset[0];
    res.json({
      total:         stats.Total,
      rechazadas:    stats.Rechazadas,
      montoTotal:    stats.MontoTotal,
      pendientePaso1,
      pendientePaso2,
      aprobadas,
      porMes:         mesRes.recordset,
      topProveedores: provRes.recordset,
      porUnidad:      unidadRes.recordset,
      recientes:      recientesRes.recordset,
    });
  } catch (err) {
    console.log("❌ ERROR DASHBOARD:", err);
    res.status(500).json({ error: err.message || "Error al obtener dashboard" });
  }
});

// ─── APROBAR / RECHAZAR ORDEN ─────────────────────────────────────────────────
app.post("/api/ordenescompra/:id/aprobar", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const { paso, aprobador } = req.body;
    if (!paso || !aprobador) return res.status(400).json({ error: "paso y aprobador requeridos" });

    await pool.request()
      .input("orderId", sql.Int, orderId)
      .input("paso", sql.Int, paso)
      .input("aprobador", sql.NVarChar(150), aprobador)
      .query(`UPDATE OrdenesCompraAprobaciones
              SET Aprobado=1, AprobadoPor=@aprobador, FechaAprobacion=SYSUTCDATETIME()
              WHERE OrdenCompraId=@orderId AND Paso=@paso`);

    // Obtener datos de la orden para el email
    const orderRes = await pool.request().input("id", sql.Int, orderId).query(`
      SELECT oc.Folio, oc.Total, p.Nombre AS Proveedor
      FROM OrdenesCompra oc INNER JOIN Proveedores p ON oc.ProveedorId=p.ProveedorId
      WHERE oc.OrdenCompraId=@id
    `);
    const order = orderRes.recordset[0];
    if (order) {
      if (paso === 1) {
        // Notificar a autorizador2
        getEmailsDeRol("autorizador2").then((emails) =>
          sendMail(emails, `Orden ${order.Folio} aprobada — requiere su autorización`,
            emailPasoAprobado(order.Folio, order.Proveedor, order.Total, 1))
        );
      } else if (paso === 2) {
        // Notificar al solicitante (creator) que la orden fue totalmente aprobada
        getEmailsDeRol("empleado").then(() => {}); // placeholder
        console.log(`✅ Orden ${order.Folio} completamente aprobada`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.log("❌ ERROR APROBAR ORDEN:", err);
    res.status(500).json({ error: err.message || "Error al aprobar" });
  }
});

app.post("/api/ordenescompra/:id/rechazar", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const { aprobador, motivo } = req.body;

    await pool.request()
      .input("id", sql.Int, orderId)
      .input("rechazadoPor", sql.NVarChar(150), aprobador || "")
      .input("motivo", sql.NVarChar(1000), motivo || "")
      .query(`UPDATE OrdenesCompra
              SET Rechazado=1, RechazadoPor=@rechazadoPor, MotivoRechazo=@motivo, FechaRechazo=SYSUTCDATETIME()
              WHERE OrdenCompraId=@id`);

    res.json({ ok: true });
  } catch (err) {
    console.log("❌ ERROR RECHAZAR ORDEN:", err);
    res.status(500).json({ error: err.message || "Error al rechazar" });
  }
});

// ─── PDF ORDEN DE COMPRA ──────────────────────────────────────────────────────
const PDFDocument = require("pdfkit");

// Constantes institucionales del documento
const PDF_DOC_NO    = "FGA01-03";
const PDF_DOC_REV   = "1";
const PDF_DOC_FECHA = "21-Ene-2021";
const PDF_EMPRESA   = "UNIVERSIDAD DE AUTOTRANSPORTE SC";
const PDF_DIRECCION = "CARRETERA A COLOMBIA 2080, COL. ANDRES CABALLERO MORENO AGROP, ESCOBEDO, N.L. CP 66080";
const PDF_LOGO_PATH = path.join(__dirname, "..", "imagenes", "UDAT_Wordmark-04.png");

function fmtMXN(val) {
  return "$" + Number(val || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Dibuja una celda con fondo, borde y texto (coordenadas absolutas, sin emojis)
function pdfCell(doc, x, y, w, h, opts) {
  const o = opts || {};
  if (o.fill) { doc.save().rect(x, y, w, h).fill(o.fill).restore(); }
  if (o.border !== false) { doc.save().rect(x, y, w, h).lineWidth(0.4).stroke("#aaaaaa").restore(); }
  const txt = o.text !== undefined && o.text !== null ? String(o.text).trim() : "";
  if (txt) {
    const size = o.size || 9;
    const ty   = y + Math.max(2, (h - size * 1.3) / 2);
    doc.save()
      .rect(x + 1, y + 1, w - 2, h - 2).clip()
      .font(o.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size).fillColor(o.color || "#111827")
      .text(txt, x + (o.pad || 5), ty, { width: w - (o.pad || 5) * 2, align: o.align || "left", lineBreak: false })
      .restore();
  }
}

app.get("/api/ordenescompra/:id/pdf", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);

    const [orderRes, lineasRes, aprobRes] = await Promise.all([
      pool.request().input("id", sql.Int, orderId).query(`
        SELECT oc.*, u.Nombre AS UnidadNegocio, p.Nombre AS Proveedor
        FROM OrdenesCompra oc
        INNER JOIN UnidadesNegocio u ON oc.UnidadNegocioId=u.UnidadNegocioId
        INNER JOIN Proveedores p ON oc.ProveedorId=p.ProveedorId
        WHERE oc.OrdenCompraId=@id`),
      pool.request().input("id", sql.Int, orderId)
        .query("SELECT * FROM OrdenesCompraLineas WHERE OrdenCompraId=@id ORDER BY OrdenLinea, OrdenCompraLineaId"),
      pool.request().input("id", sql.Int, orderId)
        .query("SELECT * FROM OrdenesCompraAprobaciones WHERE OrdenCompraId=@id ORDER BY Paso"),
    ]);

    if (!orderRes.recordset.length) return res.status(404).send("Orden no encontrada");
    const order  = orderRes.recordset[0];
    const lineas = lineasRes.recordset;
    const aprobs = aprobRes.recordset;

    const fechaOrden = order.Fecha
      ? new Date(order.Fecha).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" })
      : "—";

    const doc = new PDFDocument({ size: "LETTER", margin: 0, bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${order.Folio}.pdf"`);
    doc.pipe(res);

    const ML = 40, CW = 532;
    let y = 40;

    // ── ENCABEZADO INSTITUCIONAL ────────────────────────────────────────────
    const HDR_H = 62, LOGO_W = 82, META_W = 132, TITLE_W = CW - LOGO_W - META_W;

    pdfCell(doc, ML, y, LOGO_W, HDR_H, { fill: "#ffffff", border: true });
    try {
      const fs = require("fs");
      if (fs.existsSync(PDF_LOGO_PATH)) {
        doc.image(PDF_LOGO_PATH, ML + 6, y + 8, { fit: [LOGO_W - 12, HDR_H - 16], align: "center", valign: "center" });
      } else {
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#1e3a8a")
          .text("UDAT", ML, y + HDR_H / 2 - 8, { width: LOGO_W, align: "center" });
      }
    } catch (_) {
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#1e3a8a")
        .text("UDAT", ML, y + HDR_H / 2 - 8, { width: LOGO_W, align: "center" });
    }

    pdfCell(doc, ML + LOGO_W, y, TITLE_W, HDR_H, {
      text: "Orden de compra", size: 15, bold: true, align: "center",
    });

    const MH = HDR_H / 3, MX = ML + LOGO_W + TITLE_W;
    [[PDF_DOC_NO, "No."], [PDF_DOC_REV, "Rev."], [PDF_DOC_FECHA, "Fecha"]].forEach(([val, lbl], i) => {
      pdfCell(doc, MX, y + MH * i, META_W, MH, { fill: "#f3f4f6" });
      doc.font("Helvetica").fontSize(8).fillColor("#6b7280")
        .text(lbl, MX + 6, y + MH * i + MH / 2 - 5, { width: 38, lineBreak: false });
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#111827")
        .text(val, MX + 46, y + MH * i + MH / 2 - 5, { width: META_W - 52, lineBreak: false });
    });
    y += HDR_H;

    // ── EMPRESA + ADQUISICIONES ─────────────────────────────────────────────
    const INFO_H = 62, ADQ_W = 192, INFO_W = CW - ADQ_W;
    pdfCell(doc, ML, y, INFO_W, INFO_H, { fill: "#ffffff" });
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#1e293b")
      .text(PDF_EMPRESA, ML + 6, y + 9, { width: INFO_W - 12, lineBreak: false });
    doc.font("Helvetica").fontSize(7.5).fillColor("#475569")
      .text(PDF_DIRECCION, ML + 6, y + 23, { width: INFO_W - 12 });

    const AX = ML + INFO_W, ADQ_ROW = (INFO_H - 18) / 2;
    pdfCell(doc, AX, y, ADQ_W, 18, { fill: "#dbeafe", text: "** Datos a llenar por Adquisiciones", size: 7.5, bold: true, align: "center" });
    [["Folio", order.Folio || ""], ["Unidad de Negocio", order.UnidadNegocio || ""]].forEach(([lbl, val], i) => {
      pdfCell(doc, AX,              y + 18 + ADQ_ROW * i, ADQ_W / 2, ADQ_ROW, { fill: "#fef9c3", text: lbl, size: 8, bold: true, align: "center" });
      pdfCell(doc, AX + ADQ_W / 2, y + 18 + ADQ_ROW * i, ADQ_W / 2, ADQ_ROW, { fill: "#fef9c3", text: val, size: 8, align: "center" });
    });
    y += INFO_H;

    // ── PROVEEDOR / CREADO POR / FECHA ──────────────────────────────────────
    const ROW_H = 22, LBL_W = 95;
    pdfCell(doc, ML, y, LBL_W, ROW_H, { fill: "#f3f4f6", text: "PROVEEDOR:", bold: true, size: 9 });
    pdfCell(doc, ML + LBL_W, y, CW - LBL_W - 130, ROW_H, { text: order.Proveedor || "—", size: 9 });
    pdfCell(doc, ML + CW - 130, y, 52, ROW_H, { fill: "#f3f4f6", text: "FECHA", bold: true, size: 9, align: "center" });
    pdfCell(doc, ML + CW - 78,  y, 78, ROW_H, { text: fechaOrden, size: 9, align: "center" });
    y += ROW_H;

    pdfCell(doc, ML, y, LBL_W, ROW_H, { fill: "#f3f4f6", text: "CREADO POR:", bold: true, size: 9 });
    pdfCell(doc, ML + LBL_W, y, CW - LBL_W, ROW_H, { text: order.Creador || "—", size: 9 });
    y += ROW_H;

    // ── TABLA DE PARTIDAS ───────────────────────────────────────────────────
    const COLS = [
      { label: "Cantidad",         w: 56,  align: "center" },
      { label: "Descripcion",      w: 0,   align: "left"   },
      { label: "Unidad de medida", w: 82,  align: "center" },
      { label: "Precio Unitario",  w: 84,  align: "right"  },
      { label: "Subtotal",         w: 84,  align: "right"  },
    ];
    COLS[1].w = CW - COLS.reduce((s, c) => s + c.w, 0);

    let cx = ML;
    COLS.forEach((col) => {
      pdfCell(doc, cx, y, col.w, 20, { fill: "#1e3a8a", text: col.label, size: 8, bold: true, align: col.align, color: "#ffffff" });
      cx += col.w;
    });
    y += 20;

    const dataLineas = lineas.filter((l) => l.Descripcion);
    const totalRows  = Math.max(dataLineas.length, 8);
    for (let i = 0; i < totalRows; i++) {
      const l = dataLineas[i];
      const subtotal = l ? (l.Total != null ? Number(l.Total) : Number(l.Cantidad || 0) * Number(l.PrecioUnitario || 0)) : null;
      const rowFill  = i % 2 === 0 ? "#ffffff" : "#f8fafc";
      const vals = l ? [l.Cantidad || "", l.Descripcion, l.UnidadMedida || "", fmtMXN(l.PrecioUnitario), fmtMXN(subtotal)] : ["", "", "", "", ""];
      cx = ML;
      COLS.forEach((col, ci) => {
        pdfCell(doc, cx, y, col.w, 18, { fill: rowFill, text: vals[ci], size: 8.5, align: col.align });
        cx += col.w;
      });
      y += 18;
    }

    // ── TOTALES ─────────────────────────────────────────────────────────────
    y += 4;
    const TOT_LBL = CW - 100, TOT_VAL = 100;
    [
      { lbl: "SUBTOTAL", val: fmtMXN(order.Subtotal), bg: "#f9fafb", fg: "#111827", bold: false },
      { lbl: "IVA 16%",  val: fmtMXN(order.Iva),      bg: "#f9fafb", fg: "#111827", bold: false },
      { lbl: "TOTAL",    val: fmtMXN(order.Total),     bg: "#1e3a8a", fg: "#ffffff", bold: true  },
    ].forEach(({ lbl, val, bg, fg, bold }) => {
      pdfCell(doc, ML, y, TOT_LBL, 20, { fill: bg, text: lbl, size: 9, bold, align: "right", color: fg });
      pdfCell(doc, ML + TOT_LBL, y, TOT_VAL, 20, { fill: bg, text: val, size: 9, bold, align: "right", color: fg });
      y += 20;
    });

    // ── OBSERVACIONES ───────────────────────────────────────────────────────
    if (order.Observaciones) {
      y += 8;
      pdfCell(doc, ML, y, CW, 28, { fill: "#f8fafc" });
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#374151")
        .text("Observaciones:", ML + 6, y + 7, { width: 92, lineBreak: false });
      doc.font("Helvetica").fontSize(8).fillColor("#374151")
        .text(order.Observaciones, ML + 102, y + 7, { width: CW - 108 });
      y += 28;
    }

    // ── FLUJO DE APROBACION ─────────────────────────────────────────────────
    y += 16;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#1e3a8a").text("FLUJO DE APROBACION", ML, y);
    y += 14;

    const AP_COLS = [CW * 0.30, CW * 0.26, CW * 0.22, CW * 0.22];
    ["Etapa", "Responsable", "Estado", "Fecha"].forEach((h, i) => {
      const ax = ML + AP_COLS.slice(0, i).reduce((s, v) => s + v, 0);
      pdfCell(doc, ax, y, AP_COLS[i], 20, { fill: "#1e3a8a", text: h, size: 8, bold: true, align: "center", color: "#ffffff" });
    });
    y += 20;

    aprobs.forEach((a) => {
      const aprobado = Boolean(a.Aprobado);
      const bg = order.Rechazado && !aprobado ? "#fee2e2" : aprobado ? "#f0fdf4" : "#fffbeb";
      const estadoTxt   = order.Rechazado && !aprobado ? "Rechazado" : aprobado ? "Aprobado" : "Pendiente";
      const estadoColor = order.Rechazado && !aprobado ? "#b91c1c" : aprobado ? "#15803d" : "#92400e";
      const responsable = aprobado ? (a.AprobadoPor || "—") : order.Rechazado ? (order.RechazadoPor || "—") : "—";
      const fecha = a.FechaAprobacion ? new Date(a.FechaAprobacion).toLocaleDateString("es-MX") : "—";
      [a.Etiqueta || ("Paso " + a.Paso), responsable, estadoTxt, fecha].forEach((val, i) => {
        const ax = ML + AP_COLS.slice(0, i).reduce((s, v) => s + v, 0);
        pdfCell(doc, ax, y, AP_COLS[i], 20, { fill: bg, text: val, size: 8, align: "center", color: i === 2 ? estadoColor : "#111827", bold: i === 2 });
      });
      y += 20;
    });

    if (order.Rechazado && order.MotivoRechazo) {
      y += 4;
      pdfCell(doc, ML, y, CW, 20, { fill: "#fee2e2", text: "Motivo de rechazo: " + order.MotivoRechazo, size: 8, color: "#b91c1c" });
      y += 20;
    }

    // ── FIRMAS ──────────────────────────────────────────────────────────────
    y += 20;
    const FW = CW / 3;
    const aprobacion1 = aprobs.find((a) => a.Paso === 1);
    const aprobacion2 = aprobs.find((a) => a.Paso === 2);
    [
      { rol: "SOLICITA", nombre: order.Creador || "",           cargo: "Solicitante"       },
      { rol: "AUTORIZA", nombre: aprobacion1?.AprobadoPor || "", cargo: "Administracion"   },
      { rol: "AUTORIZA", nombre: aprobacion2?.AprobadoPor || "", cargo: "Sec. Academica"   },
    ].forEach((f, i) => {
      const fx = ML + FW * i;
      doc.save().rect(fx + 6, y, FW - 12, 70).lineWidth(0.4).stroke("#cccccc").restore();
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#1e3a8a")
        .text(f.rol, fx + 6, y + 5, { width: FW - 12, align: "center", lineBreak: false });
      doc.save().moveTo(fx + 16, y + 46).lineTo(fx + FW - 16, y + 46).lineWidth(0.6).stroke("#374151").restore();
      doc.font("Helvetica").fontSize(8).fillColor("#111827")
        .text(f.nombre || "—", fx + 6, y + 49, { width: FW - 12, align: "center", lineBreak: false });
      doc.font("Helvetica").fontSize(7.5).fillColor("#6b7280")
        .text(f.cargo, fx + 6, y + 60, { width: FW - 12, align: "center", lineBreak: false });
    });

    doc.end();
  } catch (err) {
    console.log("ERROR PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || "Error generando PDF" });
  }
});

// ─── FACTURA ─────────────────────────────────────────────────────────────────
app.post("/api/ordenescompra/:id/factura", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const { fechaFactura, monto, observaciones } = req.body;
    if (!fechaFactura) return res.status(400).json({ error: "fechaFactura requerida" });
    const r = await pool.request()
      .input("orderId", sql.Int, orderId)
      .input("fecha", sql.Date, new Date(fechaFactura))
      .input("monto", sql.Decimal(18,2), Number(monto) || 0)
      .input("obs", sql.NVarChar(2000), observaciones || null)
      .input("reg", sql.NVarChar(150), req.usuario?.nombre || null)
      .query(`
        MERGE dbo.OrdenesCompraFacturas AS t
        USING (SELECT @orderId AS OrdenCompraId) AS s ON t.OrdenCompraId = s.OrdenCompraId
        WHEN MATCHED THEN
          UPDATE SET FechaFactura=@fecha, Monto=@monto,
                     Observaciones=@obs, RegistradoPor=@reg, FechaRegistro=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (OrdenCompraId,NumeroFactura,FechaFactura,Monto,Observaciones,RegistradoPor)
          VALUES (@orderId,
                  'FAC-' + RIGHT('000' + CAST((SELECT COUNT(*)+1 FROM dbo.OrdenesCompraFacturas) AS VARCHAR(10)), 3),
                  @fecha,@monto,@obs,@reg)
        OUTPUT inserted.FacturaId, inserted.NumeroFactura;
      `);
    res.json({ facturaId: r.recordset[0]?.FacturaId, numeroFactura: r.recordset[0]?.NumeroFactura });
  } catch (err) {
    console.log("❌ ERROR FACTURA:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ordenescompra/:id/factura", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .query("SELECT * FROM dbo.OrdenesCompraFacturas WHERE OrdenCompraId=@id");
    res.json(r.recordset[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── FACTURA — SUBIR ARCHIVO ──────────────────────────────────────────────────
app.post("/api/ordenescompra/:id/factura/archivo", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const { archivoBase64, archivoNombre } = req.body;
    if (!archivoBase64 || !archivoNombre)
      return res.status(400).json({ error: "archivoBase64 y archivoNombre requeridos" });

    const base64Data = archivoBase64.replace(/^data:[^;]+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    await pool.request()
      .input("id", sql.Int, orderId)
      .input("nombre", sql.NVarChar(500), archivoNombre)
      .input("contenido", sql.VarBinary(sql.MAX), buffer)
      .query(`UPDATE dbo.OrdenesCompraFacturas
              SET ArchivoNombre=@nombre, ArchivoContenido=@contenido
              WHERE OrdenCompraId=@id`);

    res.json({ ok: true, archivoNombre });
  } catch (err) {
    console.log("❌ ERROR SUBIR ARCHIVO FACTURA:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── FACTURA — DESCARGAR ARCHIVO ──────────────────────────────────────────────
app.get("/api/ordenescompra/:id/factura/archivo", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .query("SELECT ArchivoNombre, ArchivoContenido FROM dbo.OrdenesCompraFacturas WHERE OrdenCompraId=@id");
    const row = r.recordset[0];
    if (!row?.ArchivoContenido) return res.status(404).json({ error: "No hay archivo adjunto" });

    const ext = path.extname(row.ArchivoNombre || "").toLowerCase();
    const mimeMap = { ".pdf": "application/pdf", ".xml": "application/xml",
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
    const mime = mimeMap[ext] || "application/octet-stream";

    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(row.ArchivoNombre || "factura")}"`);
    res.send(row.ArchivoContenido);
  } catch (err) {
    console.log("❌ ERROR DESCARGAR ARCHIVO FACTURA:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SOLICITUD DE FONDOS ──────────────────────────────────────────────────────
app.post("/api/ordenescompra/:id/solicitud-fondos", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const {
      monto, concepto, terminal, fechaPago, formaPago, moneda, entregarA,
      nombreBanco, ciudad, estado, pais, numSucursal, nombreSucursal,
      swift, numCuenta, claveInterbancaria, aea,
    } = req.body;

    // Obtener facturaId si existe
    const facRes = await pool.request().input("id", sql.Int, orderId)
      .query("SELECT FacturaId FROM dbo.OrdenesCompraFacturas WHERE OrdenCompraId=@id");
    const facturaId = facRes.recordset[0]?.FacturaId || null;

    const r = await pool.request()
      .input("orderId",   sql.Int,           orderId)
      .input("facturaId", sql.Int,           facturaId)
      .input("monto",     sql.Decimal(18,2), Number(monto) || 0)
      .input("concepto",  sql.NVarChar(2000),concepto || null)
      .input("creador",   sql.NVarChar(150), req.usuario?.nombre || null)
      .input("terminal",  sql.NVarChar(100), terminal || null)
      .input("fechaPago", sql.Date,          fechaPago ? new Date(fechaPago) : null)
      .input("formaPago", sql.NVarChar(20),  formaPago || null)
      .input("moneda",    sql.NVarChar(20),  moneda || null)
      .input("entregarA", sql.NVarChar(20),  entregarA || null)
      .input("banco",     sql.NVarChar(200), nombreBanco || null)
      .input("ciudad",    sql.NVarChar(100), ciudad || null)
      .input("estadoBanco", sql.NVarChar(100), estado || null)
      .input("pais",      sql.NVarChar(100), pais || null)
      .input("numSuc",    sql.NVarChar(100), numSucursal || null)
      .input("nomSuc",    sql.NVarChar(200), nombreSucursal || null)
      .input("swift",     sql.NVarChar(50),  swift || null)
      .input("numCuenta", sql.NVarChar(100), numCuenta || null)
      .input("clabe",     sql.NVarChar(100), claveInterbancaria || null)
      .input("aea",       sql.NVarChar(100), aea || null)
      .query(`
        DECLARE @nextFolio NVARCHAR(50);
        SELECT @nextFolio = 'SF-' + RIGHT('000000' + CAST(COUNT(*)+1 AS VARCHAR(10)), 6)
        FROM dbo.SolicitudesFondos;

        MERGE dbo.SolicitudesFondos AS t
        USING (SELECT @orderId AS OrdenCompraId) AS s ON t.OrdenCompraId = s.OrdenCompraId
        WHEN MATCHED THEN
          UPDATE SET Monto=@monto, Concepto=@concepto, Terminal=@terminal,
                     FechaPago=@fechaPago, FormaPago=@formaPago, Moneda=@moneda,
                     EntregarA=@entregarA, NombreBanco=@banco, Ciudad=@ciudad,
                     EstadoBanco=@estadoBanco, Pais=@pais, NumSucursal=@numSuc, NombreSucursal=@nomSuc,
                     Swift=@swift, NumCuenta=@numCuenta, ClaveInterbancaria=@clabe, AEA=@aea
        WHEN NOT MATCHED THEN
          INSERT (OrdenCompraId,FacturaId,Folio,Monto,Concepto,CreadoPor,Terminal,
                  FechaPago,FormaPago,Moneda,EntregarA,NombreBanco,Ciudad,EstadoBanco,Pais,
                  NumSucursal,NombreSucursal,Swift,NumCuenta,ClaveInterbancaria,AEA)
          VALUES (@orderId,@facturaId,@nextFolio,@monto,@concepto,@creador,@terminal,
                  @fechaPago,@formaPago,@moneda,@entregarA,@banco,@ciudad,@estadoBanco,@pais,
                  @numSuc,@nomSuc,@swift,@numCuenta,@clabe,@aea)
        OUTPUT inserted.SolicitudId, inserted.Folio;
      `);
    const row = r.recordset[0];
    res.json({ solicitudId: row?.SolicitudId, folio: row?.Folio });
  } catch (err) {
    console.log("❌ ERROR SOLICITUD FONDOS:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ordenescompra/:id/solicitud-fondos", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .query("SELECT * FROM dbo.SolicitudesFondos WHERE OrdenCompraId=@id");
    res.json(r.recordset[0] || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PDF SOLICITUD DE FONDOS ──────────────────────────────────────────────────
function numToLetras(monto) {
  const n = Math.round(Number(monto || 0) * 100);
  const pesos = Math.floor(n / 100), centavos = n % 100;
  const ones = ['','UN','DOS','TRES','CUATRO','CINCO','SEIS','SIETE','OCHO','NUEVE',
    'DIEZ','ONCE','DOCE','TRECE','CATORCE','QUINCE','DIECISEIS','DIECISIETE','DIECIOCHO','DIECINUEVE'];
  const tens = ['','','VEINTE','TREINTA','CUARENTA','CINCUENTA','SESENTA','SETENTA','OCHENTA','NOVENTA'];
  const hunds = ['','CIENTO','DOSCIENTOS','TRESCIENTOS','CUATROCIENTOS','QUINIENTOS','SEISCIENTOS','SETECIENTOS','OCHOCIENTOS','NOVECIENTOS'];
  function g3(v) {
    if (v === 0) return ''; if (v === 100) return 'CIEN';
    let s = '';
    if (v >= 100) { s = hunds[Math.floor(v/100)] + ' '; v %= 100; }
    if (v >= 20) { s += tens[Math.floor(v/10)]; if (v%10) s += ' Y ' + ones[v%10]; }
    else if (v > 0) s += ones[v];
    return s.trim();
  }
  if (pesos === 0) return `CERO PESOS ${String(centavos).padStart(2,'0')}/100 M.N.`;
  let r = '';
  const M = Math.floor(pesos/1000000); if (M) r += (M===1?'UN MILLON':g3(M)+' MILLONES') + ' ';
  const K = Math.floor((pesos%1000000)/1000); if (K) r += (K===1?'MIL':g3(K)+' MIL') + ' ';
  const U = pesos%1000; if (U) r += g3(U);
  return `${r.trim()} PESOS ${String(centavos).padStart(2,'0')}/100 M.N.`;
}

app.get("/api/ordenescompra/:id/solicitud-fondos/pdf", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const [sfRes, orderRes] = await Promise.all([
      pool.request().input("id", sql.Int, orderId)
        .query("SELECT * FROM dbo.SolicitudesFondos WHERE OrdenCompraId=@id"),
      pool.request().input("id", sql.Int, orderId)
        .query(`SELECT oc.Creador, u.Nombre AS UnidadNegocio, p.Nombre AS Proveedor
                FROM OrdenesCompra oc
                INNER JOIN UnidadesNegocio u ON oc.UnidadNegocioId=u.UnidadNegocioId
                INNER JOIN Proveedores p ON oc.ProveedorId=p.ProveedorId
                WHERE oc.OrdenCompraId=@id`),
    ]);
    if (!sfRes.recordset.length) return res.status(404).send("Solicitud de fondos no encontrada");
    const sf = sfRes.recordset[0];
    const order = orderRes.recordset[0] || {};

    const fechaSF = sf.FechaPago ? new Date(sf.FechaPago) : new Date();
    const MESES_L = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
    const DIAS_L  = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
    const fechaLarga = `${DIAS_L[fechaSF.getDay()]}, ${fechaSF.getDate()} de ${MESES_L[fechaSF.getMonth()]} de ${fechaSF.getFullYear()}`;
    const dia  = String(fechaSF.getDate()).padStart(2,'0');
    const mes  = String(fechaSF.getMonth()+1).padStart(2,'0');
    const anio = String(fechaSF.getFullYear());

    const formaPago = (sf.FormaPago || 'TRANSFERENCIA').toUpperCase();
    const moneda    = (sf.Moneda || 'MN').toUpperCase();
    const entregarA = (sf.EntregarA || 'BENEFICIARIO').toUpperCase();
    const fs2 = require("fs");

    const doc = new PDFDocument({ size: "LETTER", margin: 0, bufferPages: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="SF-${sf.Folio || orderId}.pdf"`);
    doc.pipe(res);

    const ML = 40, CW = 532;
    let y = 38;

    // ── LOGO + TÍTULOS ────────────────────────────────────────────────────────
    const LOGO_W = 88, META_W = 100, TITLE_W = CW - LOGO_W - META_W, HDR_H = 52;
    pdfCell(doc, ML, y, LOGO_W, HDR_H, { fill: "#ffffff", border: true });
    try { if (fs2.existsSync(PDF_LOGO_PATH)) doc.image(PDF_LOGO_PATH, ML+4, y+8, { fit:[LOGO_W-8,HDR_H-16], align:"center", valign:"center" }); } catch(_){}
    pdfCell(doc, ML+LOGO_W, y, TITLE_W, HDR_H/2, { fill:"#ffffff", text: PDF_EMPRESA, size:9.5, bold:true, align:"center" });
    pdfCell(doc, ML+LOGO_W, y+HDR_H/2, TITLE_W, HDR_H/2, { fill:"#dbeafe", text:"SOLICITUD DE FONDOS", size:11, bold:true, align:"center", color:"#1e40af" });
    const MX = ML+LOGO_W+TITLE_W, MH = HDR_H/3;
    [["FGA01-04","No."],["2","Rev."],["21-Ene-2021","Fecha"]].forEach(([v,l],i)=>{
      pdfCell(doc,MX,y+MH*i,META_W,MH,{fill:"#f3f4f6"});
      doc.font("Helvetica").fontSize(7.5).fillColor("#6b7280").text(l,MX+5,y+MH*i+MH/2-4.5,{width:34,lineBreak:false});
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#111827").text(v,MX+41,y+MH*i+MH/2-4.5,{width:META_W-46,lineBreak:false});
    });
    y += HDR_H;

    // ── BOX 1: DATOS GENERALES ────────────────────────────────────────────────
    const LBL_W = 108, VAL_W = 232, RIGHT_X = ML+LBL_W+VAL_W, RIGHT_W = CW-LBL_W-VAL_W;
    const ROW = 22;

    // helper checkbox
    function drawCb(cx, cy, checked, label) {
      const by = cy+(ROW-8)/2;
      doc.save().rect(cx,by,8,8).lineWidth(0.5).stroke("#374151").restore();
      if (checked) doc.save().font("Helvetica-Bold").fontSize(7).fillColor("#1d4ed8").text("X",cx+1.5,by+0.3,{lineBreak:false}).restore();
      doc.save().font("Helvetica").fontSize(7.5).fillColor("#374151").text(label,cx+11,by+0.5,{lineBreak:false}).restore();
    }

    // Fila 1: UNIDAD DE NEGOCIO + FECHA header
    pdfCell(doc,ML,y,LBL_W,ROW,{fill:"#f3f4f6",text:"UNIDAD DE NEGOCIO",bold:true,size:7.5});
    pdfCell(doc,ML+LBL_W,y,VAL_W,ROW,{text:(order.UnidadNegocio||'').toUpperCase(),size:8.5,bold:true});
    pdfCell(doc,RIGHT_X,y,RIGHT_W,ROW,{fill:"#f3f4f6",text:"FECHA",bold:true,size:8,align:"center"});
    y += ROW;

    // Fila 2: TERMINAL + DÍA|MES|AÑO headers
    pdfCell(doc,ML,y,LBL_W,ROW,{fill:"#f3f4f6",text:"TERMINAL",bold:true,size:7.5});
    pdfCell(doc,ML+LBL_W,y,VAL_W,ROW,{text:(sf.Terminal||'').toUpperCase(),size:8.5,bold:true});
    const DW = RIGHT_W/3;
    ["DÍA","MES","AÑO"].forEach((h,i)=>pdfCell(doc,RIGHT_X+DW*i,y,DW,ROW,{fill:"#e0e7ff",text:h,size:7.5,bold:true,align:"center"}));
    y += ROW;

    // Fila 3: FORMA DE PAGO label + valores fecha
    pdfCell(doc,ML,y,LBL_W+VAL_W,ROW,{fill:"#fafafa",text:"FORMA DE PAGO:",bold:true,size:8});
    [dia,mes,anio].forEach((v,i)=>pdfCell(doc,RIGHT_X+DW*i,y,DW,ROW,{text:v,size:10,bold:true,align:"center"}));
    y += ROW;

    // Fila 4: checkboxes CHEQUE/TRANSFERENCIA + "SOLICITUD DEL PAGO" rect compartido
    pdfCell(doc,ML,y,LBL_W+VAL_W,ROW*2,{fill:"#fafafa"});
    pdfCell(doc,RIGHT_X,y,RIGHT_W,ROW*2,{fill:"#fffbeb"});
    drawCb(ML+8,y,formaPago==='CHEQUE','CHEQUE');
    drawCb(ML+80,y,formaPago==='TRANSFERENCIA','TRANSFERENCIA');
    doc.font("Helvetica").fontSize(7.5).fillColor("#78350f").text("SOLICITUD DEL PAGO PARA EL DÍA:",RIGHT_X+4,y+ROW/2-4,{width:RIGHT_W-8,align:"center",lineBreak:false});
    y += ROW;

    // Fila 5: checkboxes moneda + fecha en letras
    drawCb(ML+8,y,moneda==='MN','M.N.');
    drawCb(ML+58,y,moneda==='DOLARES','DÓLARES');
    drawCb(ML+120,y,moneda==='OTRO','OTRO +');
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#b45309")
      .text(fechaLarga,RIGHT_X+4,y+ROW/2-5,{width:RIGHT_W-8,align:"center",lineBreak:false});
    y += ROW;

    // ── BOX 2: IMPORTE ────────────────────────────────────────────────────────
    y += 8;
    const IR = 22;
    pdfCell(doc,ML,y,LBL_W,IR,{fill:"#f3f4f6",text:"IMPORTE:",bold:true,size:8});
    pdfCell(doc,ML+LBL_W,y,CW-LBL_W,IR,{});
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#1d4ed8").text(fmtMXN(sf.Monto),ML+LBL_W+8,y+4,{width:CW-LBL_W-12,lineBreak:false});
    y += IR;

    const letras = numToLetras(sf.Monto);
    const LH = Math.max(IR, 14 + Math.ceil(letras.length/85)*10);
    pdfCell(doc,ML,y,LBL_W,LH,{fill:"#f3f4f6",text:"CANTIDAD (LETRA):",bold:true,size:7.5});
    pdfCell(doc,ML+LBL_W,y,CW-LBL_W,LH,{});
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#374151").text(letras,ML+LBL_W+6,y+5,{width:CW-LBL_W-10,lineBreak:true});
    y += LH;

    pdfCell(doc,ML,y,LBL_W,IR,{fill:"#f3f4f6",text:"BENEFICIARIO:",bold:true,size:8});
    pdfCell(doc,ML+LBL_W,y,CW-LBL_W,IR,{});
    doc.font("Helvetica-Bold").fontSize(9.5).fillColor("#111827").text((order.Proveedor||'').toUpperCase(),ML+LBL_W+8,y+5,{width:CW-LBL_W-12,lineBreak:false});
    y += IR;

    const DH = 28;
    pdfCell(doc,ML,y,LBL_W,DH,{fill:"#f3f4f6",text:"DESCRIPCIÓN:",bold:true,size:8});
    pdfCell(doc,ML+LBL_W,y,CW-LBL_W,DH,{});
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#1d4ed8").text((sf.Concepto||'').toUpperCase(),ML+LBL_W+6,y+7,{width:CW-LBL_W-12,align:"center",lineBreak:false});
    y += DH;

    // ── CHEQUE instrucción ────────────────────────────────────────────────────
    y += 6;
    pdfCell(doc,ML,y,70,ROW,{fill:"#f3f4f6",text:"CHEQUE",bold:true,size:8,align:"center"});
    pdfCell(doc,ML+70,y,CW-70,ROW,{fill:"#fafafa"});
    drawCb(ML+90,y,formaPago==='CHEQUE'&&entregarA==='BENEFICIARIO','ENTREGAR AL BENEFICIARIO');
    drawCb(ML+245,y,formaPago==='CHEQUE'&&entregarA==='SOLICITANTE','ENTREGAR AL SOLICITANTE');
    y += ROW;

    // ── BOX 3: TRANSFERENCIA ──────────────────────────────────────────────────
    y += 6;
    pdfCell(doc,ML,y,CW,20,{fill:"#dbeafe"});
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#1e40af").text("PARA USO EXCLUSIVO EN TRANSFERENCIA",ML+8,y+5,{width:270,lineBreak:false});
    doc.font("Helvetica").fontSize(7).fillColor("#374151").text("(Agregar copia del estado de cuenta cuando es por primera vez)",ML+282,y+6,{lineBreak:false});
    y += 20;

    const trfRows = [
      [["NOMBRE DEL BANCO",sf.NombreBanco,1.4],["CIUDAD",sf.Ciudad,0.8],["ESTADO",sf.EstadoBanco,0.8],["PAÍS",sf.Pais,0.8]],
      [["N° DE SUCURSAL",sf.NumSucursal,0.8],["NOMBRE DE LA SUCURSAL",sf.NombreSucursal,1.2],["SWIFT",sf.Swift,0.8]],
      [["N° DE CUENTA",sf.NumCuenta,0.9],["CLABE INTERBANCARIA",sf.ClaveInterbancaria,1.4],["ABA",sf.AEA||'',0.55]],
    ];
    const TR_H = 22;
    trfRows.forEach(row => {
      const total = row.reduce((s,[,,p])=>s+p,0);
      let cx = ML;
      row.forEach(([lbl,val,parts])=>{
        const w = Math.floor(CW*parts/total);
        pdfCell(doc,cx,y,w,TR_H,{fill:"#f9fafb"});
        doc.font("Helvetica-Bold").fontSize(7).fillColor("#6b7280").text(lbl,cx+4,y+3,{width:w-8,lineBreak:false});
        doc.font("Helvetica").fontSize(8).fillColor("#111827").text(String(val||''),cx+4,y+12,{width:w-8,lineBreak:false});
        doc.save().moveTo(cx+4,y+TR_H-3).lineTo(cx+w-4,y+TR_H-3).lineWidth(0.4).stroke("#d1d5db").restore();
        cx += w;
      });
      y += TR_H;
    });

    // ── FIRMAS ────────────────────────────────────────────────────────────────
    y += 14;
    const SIG_H = 68, SIG_LBL_W = 28, FW2 = (CW - SIG_LBL_W) / 3;
    pdfCell(doc,ML,y,SIG_LBL_W,SIG_H,{fill:"#f3f4f6"});
    doc.save().translate(ML+SIG_LBL_W/2+4,y+SIG_H-10).rotate(-90)
      .font("Helvetica-Bold").fontSize(7.5).fillColor("#374151")
      .text("F I R M A S",0,-3,{lineBreak:false}).restore();
    [
      {rol:"SOLICITA", nombre:order.Creador||'',   cargo:"Solicitante"},
      {rol:"AUTORIZA", nombre:sf.AprobadoPor1||'', cargo:"Administración"},
      {rol:"AUTORIZA", nombre:sf.AprobadoPor2||'', cargo:"Secretaría Académica"},
    ].forEach((f,i)=>{
      const fx = ML+SIG_LBL_W+FW2*i;
      doc.save().rect(fx,y,FW2,SIG_H).lineWidth(0.4).stroke("#d1d5db").restore();
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#1e3a8a").text(f.rol,fx,y+7,{width:FW2,align:"center",lineBreak:false});
      doc.save().moveTo(fx+10,y+46).lineTo(fx+FW2-10,y+46).lineWidth(0.6).stroke("#374151").restore();
      doc.font("Helvetica").fontSize(8).fillColor("#111827").text(f.nombre||'—',fx,y+49,{width:FW2,align:"center",lineBreak:false});
      doc.font("Helvetica").fontSize(7.5).fillColor("#6b7280").text(f.cargo,fx,y+59,{width:FW2,align:"center",lineBreak:false});
    });

    doc.end();
  } catch (err) {
    console.log("ERROR SF PDF:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── SOLICITUD DE FONDOS — APROBAR ───────────────────────────────────────────
app.post("/api/ordenescompra/:id/solicitud-fondos/aprobar", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const rol     = req.usuario?.rol;
    const nombre  = req.usuario?.nombre || '';
    const { paso } = req.body;

    // Determinar paso según rol
    let pasoNum = Number(paso) || 0;
    if (rol === 'autorizador1') pasoNum = 1;
    if (rol === 'autorizador2') pasoNum = 2;
    if (!pasoNum || ![1,2].includes(pasoNum))
      return res.status(400).json({ error: "Paso inválido (debe ser 1 o 2)" });

    const sfRes = await pool.request().input("id", sql.Int, orderId)
      .query("SELECT * FROM dbo.SolicitudesFondos WHERE OrdenCompraId=@id");
    const sf = sfRes.recordset[0];
    if (!sf) return res.status(404).json({ error: "Solicitud de fondos no encontrada" });

    if (pasoNum === 1) {
      if (sf.Aprobado1) return res.status(400).json({ error: "Ya fue aprobada en el paso 1" });
      await pool.request()
        .input("id", sql.Int, orderId).input("por", sql.NVarChar(150), nombre)
        .query(`UPDATE dbo.SolicitudesFondos SET Aprobado1=1, AprobadoPor1=@por,
                FechaAprobacion1=SYSUTCDATETIME() WHERE OrdenCompraId=@id`);
    } else {
      if (!sf.Aprobado1) return res.status(400).json({ error: "Primero debe aprobarse el paso 1 (Administración)" });
      if (sf.Aprobado2) return res.status(400).json({ error: "Ya fue aprobada en el paso 2" });
      await pool.request()
        .input("id", sql.Int, orderId).input("por", sql.NVarChar(150), nombre)
        .query(`UPDATE dbo.SolicitudesFondos SET Aprobado2=1, AprobadoPor2=@por,
                FechaAprobacion2=SYSUTCDATETIME(), Estado='aprobada' WHERE OrdenCompraId=@id`);
    }
    res.json({ ok: true });
  } catch (err) {
    console.log("❌ ERROR APROBAR SF:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SOLICITUDES DE FONDOS — PENDIENTES (para tab Autorizar) ─────────────────
app.get("/api/solicitudes-fondos/pendientes", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query(`
      SELECT sf.SolicitudId, sf.OrdenCompraId, sf.Folio, sf.Monto, sf.Estado,
             sf.Aprobado1, sf.AprobadoPor1, sf.FechaAprobacion1,
             sf.Aprobado2, sf.AprobadoPor2, sf.FechaAprobacion2,
             sf.CreadoPor, sf.FechaCreacion,
             oc.Folio AS OrdenFolio, u.Nombre AS UnidadNegocio, p.Nombre AS Proveedor
      FROM dbo.SolicitudesFondos sf
      INNER JOIN dbo.OrdenesCompra oc ON sf.OrdenCompraId = oc.OrdenCompraId
      INNER JOIN dbo.UnidadesNegocio u ON oc.UnidadNegocioId = u.UnidadNegocioId
      INNER JOIN dbo.Proveedores p ON oc.ProveedorId = p.ProveedorId
      WHERE sf.Estado != 'aprobada'
      ORDER BY sf.FechaCreacion DESC
    `);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── EVALUACIÓN AL PROVEEDOR ──────────────────────────────────────────────────
// Clave: (OrdenCompraId, Tipo) — una evaluación de compras Y una de servicios por orden

app.post("/api/ordenescompra/:id/evaluacion", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const { tipo, criterios, puntajeCalidad, puntajeTiempos, puntajeCantidad, puntajePosventa, observaciones, departamento } = req.body;
    const tipoNorm = (tipo || "compras").toLowerCase();
    const total = (Number(puntajeCalidad)||0) + (Number(puntajeTiempos)||0) + (Number(puntajeCantidad)||0) + (Number(puntajePosventa)||0);

    const existe = await pool.request()
      .input("id", sql.Int, orderId)
      .input("tipo", sql.NVarChar(20), tipoNorm)
      .query("SELECT EvaluacionId FROM dbo.EvaluacionesProveedor WHERE OrdenCompraId=@id AND Tipo=@tipo");

    const inputs = (r) => r
      .input("id",   sql.Int,           orderId)
      .input("tipo", sql.NVarChar(20),  tipoNorm)
      .input("crit", sql.NVarChar(sql.MAX), JSON.stringify(criterios || {}))
      .input("cal",  sql.Decimal(5,2),  Number(puntajeCalidad)||0)
      .input("tiem", sql.Decimal(5,2),  Number(puntajeTiempos)||0)
      .input("cant", sql.Decimal(5,2),  Number(puntajeCantidad)||0)
      .input("pos",  sql.Decimal(5,2),  Number(puntajePosventa)||0)
      .input("tot",  sql.Decimal(5,2),  total)
      .input("obs",  sql.NVarChar(2000), observaciones || null)
      .input("dep",  sql.NVarChar(200),  departamento || null)
      .input("ev",   sql.NVarChar(150),  req.usuario?.nombre || null);

    if (existe.recordset.length > 0) {
      await inputs(pool.request()).query(`
        UPDATE dbo.EvaluacionesProveedor
        SET Criterios=@crit, PuntajeCalidad=@cal, PuntajeTiempos=@tiem,
            PuntajeCantidad=@cant, PuntajePosventa=@pos, PuntajeTotal=@tot,
            Observaciones=@obs, Departamento=@dep, Evaluador=@ev,
            FechaEvaluacion=SYSUTCDATETIME()
        WHERE OrdenCompraId=@id AND Tipo=@tipo`);
    } else {
      await inputs(pool.request()).query(`
        INSERT INTO dbo.EvaluacionesProveedor
          (OrdenCompraId,Tipo,Criterios,PuntajeCalidad,PuntajeTiempos,PuntajeCantidad,PuntajePosventa,PuntajeTotal,Observaciones,Departamento,Evaluador)
        VALUES(@id,@tipo,@crit,@cal,@tiem,@cant,@pos,@tot,@obs,@dep,@ev)`);
    }
    res.json({ total, aprobada: total >= 80 });
  } catch (err) {
    console.log("❌ ERROR EVALUACION:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET ?tipo=compras|servicios  →  devuelve la evaluación de ese tipo o null
app.get("/api/ordenescompra/:id/evaluacion", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const tipo = (req.query.tipo || "").toLowerCase();

    const query = tipo
      ? "SELECT * FROM dbo.EvaluacionesProveedor WHERE OrdenCompraId=@id AND Tipo=@tipo"
      : "SELECT * FROM dbo.EvaluacionesProveedor WHERE OrdenCompraId=@id ORDER BY Tipo";

    const r = await pool.request()
      .input("id",   sql.Int,          orderId)
      .input("tipo", sql.NVarChar(20), tipo || "")
      .query(query);

    if (tipo) {
      const row = r.recordset[0];
      if (!row) return res.json(null);
      try { row.Criterios = JSON.parse(row.Criterios || "{}"); } catch { row.Criterios = {}; }
      return res.json(row);
    }

    // Sin filtro: devuelve objeto { compras: {...}|null, servicios: {...}|null }
    const result = { compras: null, servicios: null };
    for (const row of r.recordset) {
      try { row.Criterios = JSON.parse(row.Criterios || "{}"); } catch { row.Criterios = {}; }
      result[row.Tipo] = row;
    }
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
