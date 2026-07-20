require("dotenv").config();
require("dns").setDefaultResultOrder("ipv4first");
const express = require("express");
const cors = require("cors");
const sql = require("mssql");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const cloudinary = require("cloudinary").v2;

const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const APP_URL   = process.env.APP_URL   || "https://cotizador-web-coral.vercel.app";

cloudinary.config({
  cloud_name:          process.env.CLOUDINARY_CLOUD_NAME  || "kcj1hrdy",
  api_key:             process.env.CLOUDINARY_API_KEY     || "141477992514236",
  api_secret:          process.env.CLOUDINARY_API_SECRET  || "EzH_SCIZtJm9t902Wopf8lwwjOc",
  signature_algorithm: 'sha256',
});

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
              ProductoId INT NULL,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (OrdenCompraId) REFERENCES dbo.OrdenesCompra(OrdenCompraId)
            );
          END

          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompraLineas') AND name='ProductoId')
            ALTER TABLE dbo.OrdenesCompraLineas ADD ProductoId INT NULL;

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

          -- Tablas de costos y participantes de cotizaciones (si no existen)
          IF OBJECT_ID('dbo.CotizacionCostos','U') IS NULL
          BEGIN
            CREATE TABLE dbo.CotizacionCostos (
              CotizacionCostoId INT IDENTITY(1,1) PRIMARY KEY,
              CotizacionId INT NOT NULL,
              Concepto NVARCHAR(200) NULL,
              TipoCalculo NVARCHAR(100) NULL,
              Formula NVARCHAR(200) NULL,
              TipoCosto NVARCHAR(100) NULL,
              CostoUnitario DECIMAL(18,2) NOT NULL DEFAULT 0,
              Cantidad NVARCHAR(50) NULL,
              Total DECIMAL(18,2) NOT NULL DEFAULT 0,
              Orden INT NOT NULL DEFAULT 0
            );
          END

          IF OBJECT_ID('dbo.CotizacionParticipantes','U') IS NULL
          BEGIN
            CREATE TABLE dbo.CotizacionParticipantes (
              CotizacionParticipanteId INT IDENTITY(1,1) PRIMARY KEY,
              CotizacionId INT NOT NULL,
              EmpleadoId INT NULL,
              NombreCompleto NVARCHAR(300) NULL,
              Empresa NVARCHAR(200) NULL,
              Factura2 NVARCHAR(200) NULL,
              Factura3 NVARCHAR(200) NULL,
              Observaciones NVARCHAR(MAX) NULL
            );
          END

          -- Columna TipoCosto en CotizacionCostos (puede que la tabla ya exista sin ella)
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.CotizacionCostos') AND name='TipoCosto')
            ALTER TABLE dbo.CotizacionCostos ADD TipoCosto NVARCHAR(100) NULL;

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

          -- Soft delete en OrdenesCompra
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='Activo')
            ALTER TABLE dbo.OrdenesCompra ADD Activo BIT NOT NULL CONSTRAINT DF_OC_Activo DEFAULT 1;

          -- Columna Destino en OrdenesCompra
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='Destino')
            ALTER TABLE dbo.OrdenesCompra ADD Destino NVARCHAR(100) NULL;

          -- Columna ConIva en OrdenesCompra
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='ConIva')
            ALTER TABLE dbo.OrdenesCompra ADD ConIva BIT NOT NULL CONSTRAINT DF_OC_ConIva DEFAULT 1;

          -- Folio debe ser nullable para el patrón insert→getID→updateFolio
          IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='Folio' AND is_nullable=0)
            ALTER TABLE dbo.OrdenesCompra ALTER COLUMN Folio NVARCHAR(50) NULL;

          -- Columnas adicionales en Cursos
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cursos') AND name='Costo')
            ALTER TABLE dbo.Cursos ADD Costo DECIMAL(18,2) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cursos') AND name='Horas')
            ALTER TABLE dbo.Cursos ADD Horas DECIMAL(10,2) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cursos') AND name='TipoCurso')
            ALTER TABLE dbo.Cursos ADD TipoCurso NVARCHAR(50) NULL;

          -- Columna Costo en Coaches
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Coaches') AND name='Costo')
            ALTER TABLE dbo.Coaches ADD Costo DECIMAL(18,2) NULL;

          -- Hacer nullable las FKs de Cotizaciones (cursos Mandatorio no tienen CoachId)
          IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='CoachId' AND is_nullable=0)
            ALTER TABLE dbo.Cotizaciones ALTER COLUMN CoachId INT NULL;
          IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='ClienteId' AND is_nullable=0)
            ALTER TABLE dbo.Cotizaciones ALTER COLUMN ClienteId INT NULL;
          IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='CursoId' AND is_nullable=0)
            ALTER TABLE dbo.Cotizaciones ALTER COLUMN CursoId INT NULL;
          IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.Cotizaciones') AND name='ModalidadId' AND is_nullable=0)
            ALTER TABLE dbo.Cotizaciones ALTER COLUMN ModalidadId INT NULL;

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

          -- Órdenes de Mantenimiento
          IF OBJECT_ID('dbo.OrdenesMantenimiento','U') IS NULL
            CREATE TABLE dbo.OrdenesMantenimiento (
              OrdenMantenimientoId INT IDENTITY(1,1) PRIMARY KEY,
              Folio              NVARCHAR(50)   NULL,
              Departamento       NVARCHAR(200)  NULL,
              FechaReporte       DATE           NULL,
              NombreSolicita     NVARCHAR(300)  NULL,
              Puesto             NVARCHAR(200)  NULL,
              Equipo             NVARCHAR(200)  NULL,
              Codigo             NVARCHAR(100)  NULL,
              RazonOrden         NVARCHAR(100)  NULL,
              DescripcionFalla   NVARCHAR(MAX)  NULL,
              TipoFalla          NVARCHAR(100)  NULL,
              FechaTerminacion   DATE           NULL,
              DescripcionMantenimiento NVARCHAR(MAX) NULL,
              TecnicoResponsable NVARCHAR(300)  NULL,
              UsuarioEquipo      NVARCHAR(300)  NULL,
              Estado             NVARCHAR(50)   NOT NULL DEFAULT 'Pendiente',
              CreadoPor          NVARCHAR(150)  NULL,
              FechaCreacion      DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
              OrdenCompraId      INT            NULL,
              Activo             BIT            NOT NULL DEFAULT 1
            );

          IF OBJECT_ID('dbo.OrdenesMantenimientoMateriales','U') IS NULL
            CREATE TABLE dbo.OrdenesMantenimientoMateriales (
              MaterialId              INT IDENTITY(1,1) PRIMARY KEY,
              OrdenMantenimientoId    INT NOT NULL,
              Material                NVARCHAR(500) NULL,
              Cantidad                NVARCHAR(100) NULL,
              ProductoId              INT NULL,
              FOREIGN KEY (OrdenMantenimientoId) REFERENCES dbo.OrdenesMantenimiento(OrdenMantenimientoId)
            );

          -- Columna ProductoId en materiales (si la tabla ya existía sin ella)
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesMantenimientoMateriales') AND name='ProductoId')
            ALTER TABLE dbo.OrdenesMantenimientoMateriales ADD ProductoId INT NULL;

          -- Inventario de materiales
          IF OBJECT_ID('dbo.Inventario','U') IS NULL
            CREATE TABLE dbo.Inventario (
              ProductoId      INT IDENTITY(1,1) PRIMARY KEY,
              NombreProducto  NVARCHAR(300) NOT NULL,
              Descripcion     NVARCHAR(500) NULL,
              UnidadMedida    NVARCHAR(100) NULL DEFAULT 'pza',
              CantidadMinima  DECIMAL(10,2) NOT NULL DEFAULT 0,
              CantidadReal    DECIMAL(10,2) NOT NULL DEFAULT 0,
              Precio          DECIMAL(18,2) NULL DEFAULT 0,
              Activo          BIT NOT NULL DEFAULT 1,
              FechaCreacion   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            );

          IF OBJECT_ID('dbo.InventarioMovimientos','U') IS NULL
            CREATE TABLE dbo.InventarioMovimientos (
              MovimientoId         INT IDENTITY(1,1) PRIMARY KEY,
              ProductoId           INT NOT NULL,
              TipoMovimiento       NVARCHAR(50)  NOT NULL,
              Cantidad             DECIMAL(10,2) NOT NULL,
              CantidadAnterior     DECIMAL(10,2) NOT NULL DEFAULT 0,
              OrdenMantenimientoId INT NULL,
              OrdenCompraId        INT NULL,
              Usuario              NVARCHAR(150) NULL,
              Referencia           NVARCHAR(300) NULL,
              Fecha                DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (ProductoId) REFERENCES dbo.Inventario(ProductoId)
            );

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

        // ── Tablas del módulo de Seguridad ────────────────────────────────────
        await pool.request().query(`
          IF OBJECT_ID('dbo.Vehiculos','U') IS NULL
          BEGIN
            CREATE TABLE dbo.Vehiculos (
              VehiculoId   INT IDENTITY(1,1) PRIMARY KEY,
              Marca        NVARCHAR(100) NOT NULL,
              Modelo       NVARCHAR(100) NOT NULL,
              Placa        NVARCHAR(20)  NOT NULL,
              Año          INT           NULL,
              Color        NVARCHAR(50)  NULL,
              Capacidad    INT           NULL,
              Activo       BIT           NOT NULL DEFAULT 1,
              FechaCreacion DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END

          IF OBJECT_ID('dbo.Extintores','U') IS NULL
          BEGIN
            CREATE TABLE dbo.Extintores (
              ExtintorId       INT IDENTITY(1,1) PRIMARY KEY,
              Codigo           NVARCHAR(50)  NOT NULL,
              Tipo             NVARCHAR(50)  NULL,
              Ubicacion        NVARCHAR(300) NULL,
              FechaVencimiento DATE          NULL,
              Activo           BIT           NOT NULL DEFAULT 1,
              FechaCreacion    DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END

          IF OBJECT_ID('dbo.PuntosRevision','U') IS NULL
          BEGIN
            CREATE TABLE dbo.PuntosRevision (
              PuntoRevisionId INT IDENTITY(1,1) PRIMARY KEY,
              Nombre          NVARCHAR(200) NOT NULL,
              Descripcion     NVARCHAR(500) NULL,
              Activo          BIT           NOT NULL DEFAULT 1,
              FechaCreacion   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END

          IF OBJECT_ID('dbo.AreasRevision','U') IS NULL
          BEGIN
            CREATE TABLE dbo.AreasRevision (
              AreaRevisionId  INT IDENTITY(1,1) PRIMARY KEY,
              PuntoRevisionId INT           NOT NULL,
              Nombre          NVARCHAR(200) NOT NULL,
              Activo          BIT           NOT NULL DEFAULT 1,
              FOREIGN KEY (PuntoRevisionId) REFERENCES dbo.PuntosRevision(PuntoRevisionId)
            );
          END
        `);

        await pool.request().query(`
          IF OBJECT_ID('dbo.Rondines','U') IS NULL
          BEGIN
            CREATE TABLE dbo.Rondines (
              RondinId      INT IDENTITY(1,1) PRIMARY KEY,
              Folio         NVARCHAR(50)  NULL,
              Guardia       NVARCHAR(200) NULL,
              FechaInicio   DATETIME2     NULL,
              FechaFin      DATETIME2     NULL,
              Estado        NVARCHAR(50)  NOT NULL DEFAULT 'en_curso',
              Observaciones NVARCHAR(MAX) NULL,
              FechaCreacion DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END

          IF OBJECT_ID('dbo.RondinesRegistros','U') IS NULL
          BEGIN
            CREATE TABLE dbo.RondinesRegistros (
              RegistroId              INT IDENTITY(1,1) PRIMARY KEY,
              RondinId                INT           NOT NULL,
              PuntoRevisionId         INT           NULL,
              AreaRevisionId          INT           NULL,
              Revisado                BIT           NOT NULL DEFAULT 0,
              HoraRevision            DATETIME2     NULL,
              TieneIncidencia         BIT           NOT NULL DEFAULT 0,
              NivelSeveridad          NVARCHAR(20)  NULL,
              DescripcionIncidencia   NVARCHAR(MAX) NULL,
              RequiereMantenimiento   BIT           NOT NULL DEFAULT 0,
              OrdenMantenimientoId    INT           NULL,
              FOREIGN KEY (RondinId)       REFERENCES dbo.Rondines(RondinId),
              FOREIGN KEY (PuntoRevisionId) REFERENCES dbo.PuntosRevision(PuntoRevisionId),
              FOREIGN KEY (AreaRevisionId)  REFERENCES dbo.AreasRevision(AreaRevisionId)
            );
          END

          IF OBJECT_ID('dbo.RevisionesExtintores','U') IS NULL
          BEGIN
            CREATE TABLE dbo.RevisionesExtintores (
              RevisionId         INT IDENTITY(1,1) PRIMARY KEY,
              ExtintorId         INT          NOT NULL,
              Guardia            NVARCHAR(200) NULL,
              FechaRevision      DATE         NOT NULL,
              PresionAdecuada    BIT          NULL,
              CondicionFisica    NVARCHAR(100) NULL,
              VencimientoVigente BIT          NULL,
              Observaciones      NVARCHAR(MAX) NULL,
              FechaCreacion      DATETIME2    NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (ExtintorId) REFERENCES dbo.Extintores(ExtintorId)
            );
          END

          IF OBJECT_ID('dbo.Visitas','U') IS NULL
          BEGIN
            CREATE TABLE dbo.Visitas (
              VisitaId        INT IDENTITY(1,1) PRIMARY KEY,
              Folio           NVARCHAR(50)  NULL,
              NombreVisitante NVARCHAR(300) NOT NULL,
              Empresa         NVARCHAR(200) NULL,
              Documento       NVARCHAR(100) NULL,
              TipoVisita      NVARCHAR(50)  NULL,
              AQuienVisita    NVARCHAR(300) NULL,
              Motivo          NVARCHAR(500) NULL,
              HoraEntrada     DATETIME2     NULL,
              HoraSalida      DATETIME2     NULL,
              Guardia         NVARCHAR(200) NULL,
              Observaciones   NVARCHAR(MAX) NULL,
              FechaCreacion   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END

          IF OBJECT_ID('dbo.OrdenesVehiculo','U') IS NULL
          BEGIN
            CREATE TABLE dbo.OrdenesVehiculo (
              OrdenVehiculoId      INT IDENTITY(1,1) PRIMARY KEY,
              Folio                NVARCHAR(50)   NULL,
              VehiculoId           INT            NULL,
              Solicitante          NVARCHAR(200)  NULL,
              Destino              NVARCHAR(300)  NULL,
              Motivo               NVARCHAR(500)  NULL,
              FechaSalidaEstimada  DATE           NULL,
              HoraSalidaEstimada   NVARCHAR(10)   NULL,
              Pasajeros            INT            NULL,
              Estado               NVARCHAR(50)   NOT NULL DEFAULT 'pendiente',
              AutorizadoPor        NVARCHAR(200)  NULL,
              FechaAutorizacion    DATETIME2      NULL,
              MotivoRechazo        NVARCHAR(500)  NULL,
              HoraSalidaReal       DATETIME2      NULL,
              HoraLlegada          DATETIME2      NULL,
              KmInicial            DECIMAL(10,2)  NULL,
              KmFinal              DECIMAL(10,2)  NULL,
              RegistradoPorSalida  NVARCHAR(200)  NULL,
              RegistradoPorLlegada NVARCHAR(200)  NULL,
              Observaciones        NVARCHAR(MAX)  NULL,
              FechaCreacion        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END
        `);
        // Columnas adicionales en RondinesRegistros (agregadas en v2)
        await pool.request().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.RondinesRegistros') AND name='FotoUrl')
            ALTER TABLE dbo.RondinesRegistros ADD FotoUrl NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.RondinesRegistros') AND name='OrdenMantenimientoId')
            ALTER TABLE dbo.RondinesRegistros ADD OrdenMantenimientoId INT NULL;
        `);
        // Columnas de fotos en OrdenesVehiculo (agregadas en v3)
        await pool.request().query(`
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoSalidaFrontal')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoSalidaFrontal NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoSalidaTrasero')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoSalidaTrasero NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoSalidaLateralIzq')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoSalidaLateralIzq NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoSalidaLateralDer')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoSalidaLateralDer NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoLlegadaFrontal')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoLlegadaFrontal NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoLlegadaTrasero')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoLlegadaTrasero NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoLlegadaLateralIzq')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoLlegadaLateralIzq NVARCHAR(500) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesVehiculo') AND name='FotoLlegadaLateralDer')
            ALTER TABLE dbo.OrdenesVehiculo ADD FotoLlegadaLateralDer NVARCHAR(500) NULL;
        `);
        console.log("✅ Tablas de seguridad aseguradas");

        // ── Tablas de Consumos de Limpieza y recepción de OC ─────────────────
        await pool.request().query(`
          IF OBJECT_ID('dbo.AreasConsumo','U') IS NULL
          BEGIN
            CREATE TABLE dbo.AreasConsumo (
              AreaConsumoId INT IDENTITY(1,1) PRIMARY KEY,
              Nombre        NVARCHAR(200) NOT NULL,
              Activo        BIT NOT NULL DEFAULT 1,
              FechaCreacion DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
            );
          END

          IF OBJECT_ID('dbo.ConsumosLimpieza','U') IS NULL
          BEGIN
            CREATE TABLE dbo.ConsumosLimpieza (
              ConsumoId     INT IDENTITY(1,1) PRIMARY KEY,
              ProductoId    INT NOT NULL,
              AreaConsumoId INT NULL,
              Cantidad      DECIMAL(10,2) NOT NULL,
              Usuario       NVARCHAR(150) NOT NULL,
              Observaciones NVARCHAR(500) NULL,
              Fecha         DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
              FOREIGN KEY (ProductoId) REFERENCES dbo.Inventario(ProductoId)
            );
          END

          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='Recepcionada')
            ALTER TABLE dbo.OrdenesCompra ADD Recepcionada BIT NOT NULL DEFAULT 0;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='FechaRecepcion')
            ALTER TABLE dbo.OrdenesCompra ADD FechaRecepcion DATETIME2 NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompra') AND name='RecibidoPor')
            ALTER TABLE dbo.OrdenesCompra ADD RecibidoPor NVARCHAR(150) NULL;
          IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id=OBJECT_ID('dbo.OrdenesCompraLineas') AND name='CantidadRecibida')
            ALTER TABLE dbo.OrdenesCompraLineas ADD CantidadRecibida DECIMAL(10,2) NULL;
        `);
        console.log("✅ Tablas de consumos y recepción OC aseguradas");

      } catch (e) {
        console.log("❌ Error asegurando tablas:", e);
      }
    })();
  })
  .catch((err) => console.log("❌ Error SQL:", err));

// ─── Email helpers ────────────────────────────────────────────────────────────
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASS = process.env.GMAIL_APP_PASS || "";

const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
});

if (GMAIL_USER && GMAIL_APP_PASS) {
  console.log("✅ Gmail SMTP configurado — correos habilitados");
} else {
  console.log("⚠️ GMAIL_USER/GMAIL_APP_PASS no configurado — correos deshabilitados");
}

async function sendMail(to, subject, html) {
  if (!to || !to.length) return;
  if (!GMAIL_USER || !GMAIL_APP_PASS) {
    console.log(`⚠️ Email no enviado: ${subject}`);
    return;
  }
  try {
    const toStr = Array.isArray(to) ? to.join(",") : to;
    await mailTransporter.sendMail({
      from: `"Sistema UDAT" <${GMAIL_USER}>`,
      to: toStr,
      subject,
      html,
    });
    console.log(`✅ Email enviado (Gmail) a: ${toStr}`);
  } catch (e) {
    console.log("⚠️ Error Gmail SMTP:", e.message);
  }
}

async function getEmailsDeRol(rol) {
  if (!pool) return [];
  try {
    const r = await pool.request()
      .input("rol", sql.NVarChar(50), rol)
      .query("SELECT DISTINCT Correo FROM dbo.Usuarios WHERE (Rol=@rol OR Rol='admin') AND Activo=1");
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

async function getEmailsPorRoles(roles) {
  if (!pool || !roles.length) return [];
  try {
    const placeholders = roles.map((_, i) => `@r${i}`).join(',');
    const req = pool.request();
    roles.forEach((rol, i) => req.input(`r${i}`, sql.NVarChar(50), rol));
    const r = await req.query(`SELECT DISTINCT Correo FROM dbo.Usuarios WHERE Rol IN (${placeholders}) AND Activo=1 AND Correo IS NOT NULL AND Correo != ''`);
    return r.recordset.map(u => u.Correo).filter(Boolean);
  } catch { return []; }
}

function emailOMCreada(folio, equipo, departamento, razon, solicitante) {
  const razonLabel = { correctivo: 'Mantenimiento Correctivo', preventivo: 'Mantenimiento Preventivo', predictivo: 'Mantenimiento Predictivo', programado: 'Mantenimiento Programado' };
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1e3a5f;padding:16px 20px;border-radius:6px 6px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">Nueva Orden de Mantenimiento</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 6px 6px">
        <p style="margin:0 0 16px;color:#374151">Se ha registrado una nueva orden de mantenimiento que requiere atención:</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6;width:42%">Folio</td><td style="padding:8px 10px;background:#f3f4f6">${folio}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Equipo / Área</td><td style="padding:8px 10px">${equipo || '-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Departamento</td><td style="padding:8px 10px;background:#f3f4f6">${departamento || '-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Tipo de mantenimiento</td><td style="padding:8px 10px">${razonLabel[razon] || razon || '-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Solicitante</td><td style="padding:8px 10px;background:#f3f4f6">${solicitante || '-'}</td></tr>
        </table>
        <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px;font-weight:bold">Ver en el sistema</a>
      </div>
    </div>`;
}

function emailOMCompletada(folio, equipo, tecnico, tipoFalla, descripcion, materiales) {
  const matsHtml = materiales && materiales.length
    ? `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">
        <tr style="background:#1e3a5f"><th style="padding:6px 10px;text-align:left;color:#fff">Refacción / Material</th><th style="padding:6px 10px;text-align:center;color:#fff">Cantidad</th></tr>
        ${materiales.map((m, i) => `<tr style="background:${i%2===0?'#fff':'#f3f4f6'}"><td style="padding:6px 10px">${m.material||''}</td><td style="padding:6px 10px;text-align:center">${m.cantidad||''}</td></tr>`).join('')}
      </table>`
    : '<p style="color:#6b7280;font-size:13px;margin:0 0 16px">Sin materiales registrados.</p>';
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#15803d;padding:16px 20px;border-radius:6px 6px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">✓ Orden de Mantenimiento Completada</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 6px 6px">
        <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6;width:42%">Folio</td><td style="padding:8px 10px;background:#f3f4f6">${folio}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Equipo / Área</td><td style="padding:8px 10px">${equipo || '-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Técnico responsable</td><td style="padding:8px 10px;background:#f3f4f6">${tecnico || '-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Tipo de falla</td><td style="padding:8px 10px">${tipoFalla || '-'}</td></tr>
        </table>
        ${descripcion ? `<div style="margin:0 0 16px"><p style="font-weight:bold;margin:0 0 6px;color:#374151">Descripción del trabajo realizado:</p><p style="margin:0;padding:10px 14px;background:#f3f4f6;border-radius:4px;color:#374151;line-height:1.6">${descripcion}</p></div>` : ''}
        <p style="font-weight:bold;margin:0 0 8px;color:#374151">Materiales utilizados:</p>
        ${matsHtml}
        <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px;font-weight:bold">Ver en el sistema</a>
      </div>
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

function emailOCConfirmacion(folio, proveedor, total) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e3a5f">Orden de Compra Registrada</h2>
      <p>Tu orden de compra ha sido registrada exitosamente y está <strong>pendiente de aprobación</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Proveedor</td><td style="padding:8px">${proveedor}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Total</td><td style="padding:8px">$${Number(total).toFixed(2)}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px">Recibirás una notificación cuando sea aprobada o rechazada.</p>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ver en el sistema
      </a>
    </div>`;
}

function emailOCResultado(folio, proveedor, total, aprobada, aprobador, motivo) {
  const color = aprobada ? '#15803d' : '#b91c1c';
  const bg    = aprobada ? '#f0fdf4' : '#fef2f2';
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:${color}">Orden ${folio} — ${aprobada ? 'Aprobada' : 'Rechazada'}</h2>
      <div style="background:${bg};border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0;color:${color};font-weight:600">
          ${aprobada ? '✅ Tu orden de compra ha sido completamente aprobada.' : '❌ Tu orden de compra ha sido rechazada.'}
        </p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Proveedor</td><td style="padding:8px">${proveedor}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Total</td><td style="padding:8px">$${Number(total).toFixed(2)}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Revisado por</td><td style="padding:8px">${aprobador || '-'}</td></tr>
        ${motivo ? `<tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Motivo de rechazo</td><td style="padding:8px">${motivo}</td></tr>` : ''}
      </table>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ver en el sistema
      </a>
    </div>`;
}

function emailCotizacionConfirmacion(folio, total, creadoPor) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#1e3a5f">Cotización Registrada</h2>
      <p>Tu cotización ha sido registrada y está <strong>pendiente de aprobación</strong> por el autorizador.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Creado por</td><td style="padding:8px">${creadoPor || '-'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Total con ganancia</td><td style="padding:8px">$${Number(total || 0).toLocaleString('es-MX', { minimumFractionDigits: 2 })}</td></tr>
      </table>
      <p style="color:#6b7280;font-size:13px">Recibirás una notificación cuando sea aprobada o rechazada.</p>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">
        Ver en el sistema
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

function emailIncidenciaSeguridad(rondinFolio, punto, area, severidad, descripcion, guardia) {
  const colores = { critica: '#b91c1c', alta: '#d97706', media: '#2563eb', baja: '#15803d' };
  const color = colores[severidad] || '#374151';
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:${color};padding:16px 20px;border-radius:6px 6px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">⚠️ Incidencia de Seguridad — ${(severidad||'').toUpperCase()}</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 6px 6px">
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6;width:40%">Rondín</td><td style="padding:8px 10px;background:#f3f4f6">${rondinFolio||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Punto de revisión</td><td style="padding:8px 10px">${punto||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Área</td><td style="padding:8px 10px;background:#f3f4f6">${area||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Severidad</td><td style="padding:8px 10px;color:${color};font-weight:bold">${severidad||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Registrado por</td><td style="padding:8px 10px;background:#f3f4f6">${guardia||'-'}</td></tr>
        </table>
        ${descripcion?`<p style="margin:0 0 8px;font-weight:bold">Descripción:</p><p style="margin:0 0 16px;padding:10px 14px;background:#f3f4f6;border-radius:4px;line-height:1.6">${descripcion}</p>`:''}
        <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px;font-weight:bold">Ver en el sistema</a>
      </div>
    </div>`;
}

function emailSolicitudVehiculo(folio, vehiculo, destino, motivo, fechaSalida, horaSalida, solicitante) {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#1e3a5f;padding:16px 20px;border-radius:6px 6px 0 0">
        <h2 style="color:#fff;margin:0;font-size:18px">Nueva Solicitud de Vehículo — ${folio}</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 6px 6px">
        <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6;width:40%">Folio</td><td style="padding:8px 10px;background:#f3f4f6">${folio}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Solicitante</td><td style="padding:8px 10px">${solicitante||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Vehículo</td><td style="padding:8px 10px;background:#f3f4f6">${vehiculo||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Destino</td><td style="padding:8px 10px">${destino||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold;background:#f3f4f6">Motivo</td><td style="padding:8px 10px;background:#f3f4f6">${motivo||'-'}</td></tr>
          <tr><td style="padding:8px 10px;font-weight:bold">Salida estimada</td><td style="padding:8px 10px">${fechaSalida||'-'} ${horaSalida||''}</td></tr>
        </table>
        <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px;font-weight:bold">Autorizar en el sistema</a>
      </div>
    </div>`;
}

function emailVehiculoResuelto(folio, vehiculo, destino, estado, motivo) {
  const aprobada = estado === 'autorizada';
  const color = aprobada ? '#15803d' : '#b91c1c';
  const bg    = aprobada ? '#f0fdf4' : '#fef2f2';
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:${color}">Solicitud ${folio} — ${aprobada ? 'Autorizada' : 'Rechazada'}</h2>
      <div style="background:${bg};border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0;color:${color};font-weight:600">${aprobada ? '✅ Tu solicitud de vehículo ha sido autorizada.' : '❌ Tu solicitud de vehículo fue rechazada.'}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Folio</td><td style="padding:8px">${folio}</td></tr>
        <tr><td style="padding:8px;font-weight:bold">Vehículo</td><td style="padding:8px">${vehiculo||'-'}</td></tr>
        <tr><td style="padding:8px;font-weight:bold;background:#f3f4f6">Destino</td><td style="padding:8px;background:#f3f4f6">${destino||'-'}</td></tr>
        ${motivo?`<tr><td style="padding:8px;font-weight:bold">Motivo de rechazo</td><td style="padding:8px">${motivo}</td></tr>`:''}
      </table>
      <a href="${APP_URL}" style="display:inline-block;padding:12px 24px;background:#1e3a5f;color:white;text-decoration:none;border-radius:6px">Ver en el sistema</a>
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
    destino: "Destino",
    observaciones: "Observaciones", subtotal: "Subtotal", iva: "Iva", total: "Total",
    coniva: "ConIva",
    creador: "Creador", rechazado: "Rechazado", rechazadopor: "RechazadoPor",
    fecharechazo: "FechaRechazo", motivorechazo: "MotivoRechazo",
    modificadopor: "ModificadoPor", fechamodificacion: "FechaModificacion",
  },
  OrdenesCompraLineas: {
    cantidad: "Cantidad", descripcion: "Descripcion", unidadmedida: "UnidadMedida",
    preciounitario: "PrecioUnitario", total: "Total", ordenlinea: "OrdenLinea",
    ordencompralid: "OrdenCompraId", ordencompraid: "OrdenCompraId",
    productoid: "ProductoId",
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
  // Folio will be set after INSERT using the actual DB-assigned ID (no race condition)
  delete orderData.Folio;

  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const orderId = await insertCatalogItemInTransaction(transaction, "OrdenesCompra", orderData);
    // Generate folio from the real ID and update in the same transaction
    const folio = generateOrderFolio(orderId);
    await new sql.Request(transaction)
      .input("folio", sql.NVarChar(50), folio)
      .input("id", sql.Int, orderId)
      .query("UPDATE OrdenesCompra SET Folio = @folio WHERE OrdenCompraId = @id");
    for (const item of lineItems) {
      await insertCatalogItemInTransaction(transaction, "OrdenesCompraLineas", normalizeRecord({ ...item, OrdenCompraId: orderId }, "OrdenesCompraLineas"));
      // Stock se actualiza al confirmar recepción (POST /api/ordenescompra/:id/recepcion)
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

const generateOrderFolio = (id) => {
  const year = new Date().getFullYear();
  return `OC-${year}-${String(id).padStart(6, "0")}`;
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

function soloEncargadoVehiculos(req, res, next) {
  const rolesPermitidos = ['admin', 'encargado_vehiculos'];
  if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
    return res.status(403).json({ error: 'Solo el encargado de vehículos puede realizar esta acción' });
  }
  next();
}

function soloAdminOJefeSeg(req, res, next) {
  const rolesPermitidos = ['admin', 'jefe_seguridad'];
  if (!req.usuario || !rolesPermitidos.includes(req.usuario.rol)) {
    return res.status(403).json({ error: 'Acceso solo para administradores o jefe de seguridad' });
  }
  next();
}

// TEST
app.get("/", (req, res) => res.send("API funcionando"));

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.get("/api/auth/me", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const result = await pool.request()
      .input("id", sql.Int, req.usuario.id)
      .query("SELECT UsuarioId, Correo, Nombre, Rol, DebeReiniciarPass, Activo FROM dbo.Usuarios WHERE UsuarioId=@id AND Activo=1");
    if (!result.recordset[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    const u = result.recordset[0];
    const newToken = jwt.sign(
      { id: u.UsuarioId, correo: u.Correo, nombre: u.Nombre, rol: u.Rol },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token: newToken, usuario: { id: u.UsuarioId, correo: u.Correo, nombre: u.Nombre, rol: u.Rol, debeReiniciarPass: u.DebeReiniciarPass } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
    const result = await pool.request().query(`SELECT CoachId, Nombre, Costo FROM Coaches WHERE Activo = 1 ORDER BY Nombre`);
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
        co.Nombre AS Coach,  m.Nombre  AS Modalidad,
        cu.Horas  AS HorasCurso
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

      // Notificar al autorizador1 y al creador (sin bloquear la respuesta)
      ;(async () => {
        try {
          const [emailsAut, emailsCreador] = await Promise.all([
            getEmailsDeRol("autorizador1"),
            getEmailDeUsuario(d.creadoPor),
          ]);
          let clienteNombre = null, cursoNombre = null;
          try {
            if (d.clienteId) {
              const r = await pool.request().input('_cid', sql.Int, Number(d.clienteId))
                .query('SELECT Nombre FROM Empresas WHERE EmpresaId=@_cid');
              clienteNombre = r.recordset[0]?.Nombre || null;
            }
            if (d.cursoId) {
              const r = await pool.request().input('_cuid', sql.Int, Number(d.cursoId))
                .query('SELECT Nombre FROM Cursos WHERE CursoId=@_cuid');
              cursoNombre = r.recordset[0]?.Nombre || null;
            }
          } catch (e) { console.log('⚠️ Error obteniendo nombres para email cotización:', e.message); }

          console.log(`📧 Cotización ${d.folio} — autorizadores encontrados: ${emailsAut.join(',') || 'ninguno'}`);
          if (emailsAut.length) {
            await sendMail(emailsAut, `Nueva cotización ${d.folio} requiere su aprobación`,
              emailCotizacionPendiente(d.folio, clienteNombre, cursoNombre, d.totalConGanancia, d.creadoPor));
            console.log(`✅ Email cotización enviado a autorizador1: ${emailsAut.join(',')}`);
          }
          if (emailsCreador.length) {
            await sendMail(emailsCreador, `Tu cotización ${d.folio} fue registrada y está pendiente de aprobación`,
              emailCotizacionConfirmacion(d.folio, d.totalConGanancia, d.creadoPor));
          }
        } catch (e) { console.log('❌ Error enviando email cotización:', e.message); }
      })();
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

app.put("/api/cotizaciones/:id", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body, id = Number(req.params.id);
    const costos = d.costos || [];
    const participantes = d.participantes || [];

    // Solo el creador (o admin) puede editar
    const cotCheck = await pool.request().input("id", sql.Int, id)
      .query("SELECT CreadoPor FROM Cotizaciones WHERE CotizacionId=@id");
    if (!cotCheck.recordset.length) return res.status(404).json({ error: "Cotización no encontrada" });
    const creador = cotCheck.recordset[0].CreadoPor;
    if (req.usuario.rol !== 'admin' && req.usuario.nombre !== creador) {
      return res.status(403).json({ error: "Solo el creador puede editar esta cotización" });
    }

    const schemaCheck = await pool.request().query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_NAME='Cotizaciones' AND COLUMN_NAME IN (
        'ClienteId','CursoId','CoachId','ModalidadId',
        'MargenUtilidadPctDirectos','MargenUtilidadDirectos',
        'MargenUtilidadPctIndirectos','MargenUtilidadIndirectos'
      )
    `);
    const existingCols = new Set(schemaCheck.recordset.map(r => r.COLUMN_NAME));

    const setParts = [
      "DuracionDias=@DuracionDias","SesionesPorDia=@SesionesPorDia",
      "ParticipantesCantidad=@ParticipantesCantidad",
      "FechaInicio=@FechaInicio","FechaFin=@FechaFin","Observaciones=@Observaciones",
      "TotalCostosDirectos=@TotalCostosDirectos","TotalCostosIndirectos=@TotalCostosIndirectos",
      "TotalCostos=@TotalCostos","MargenUtilidadPct=@MargenUtilidadPct",
      "MargenUtilidad=@MargenUtilidad","TotalConGanancia=@TotalConGanancia",
      "PrecioPorParticipante=@PrecioPorParticipante",
      "PrecioSugeridoPorParticipante=@PrecioSugeridoPorParticipante",
      "Estado='Pendiente'",
    ];

    const req1 = pool.request()
      .input("id",                            sql.Int,               id)
      .input("DuracionDias",                  sql.Int,               d.duracionDias          || null)
      .input("SesionesPorDia",                sql.Int,               d.sesionesPorDia        || null)
      .input("ParticipantesCantidad",         sql.Int,               d.participantesCantidad || null)
      .input("FechaInicio",                   sql.Date,              d.fechaInicio           || null)
      .input("FechaFin",                      sql.Date,              d.fechaFin              || null)
      .input("Observaciones",                 sql.NVarChar(sql.MAX), d.observaciones         || null)
      .input("TotalCostosDirectos",           sql.Decimal(18,2),     d.totalCostosDirectos   || 0)
      .input("TotalCostosIndirectos",         sql.Decimal(18,2),     d.totalCostosIndirectos || 0)
      .input("TotalCostos",                   sql.Decimal(18,2),     d.totalCostos           || 0)
      .input("MargenUtilidadPct",             sql.Decimal(18,4),     d.margenUtilidadPct     || 0)
      .input("MargenUtilidad",                sql.Decimal(18,2),     d.margenUtilidad        || 0)
      .input("TotalConGanancia",              sql.Decimal(18,2),     d.totalConGanancia      || 0)
      .input("PrecioPorParticipante",         sql.Decimal(18,2),     d.precioPorParticipante || 0)
      .input("PrecioSugeridoPorParticipante", sql.Decimal(18,2),     d.precioSugeridoPorParticipante || 0);

    if (d.clienteId   && existingCols.has("ClienteId"))   { setParts.push("ClienteId=@ClienteId");     req1.input("ClienteId",   sql.Int, Number(d.clienteId));   }
    if (d.cursoId     && existingCols.has("CursoId"))     { setParts.push("CursoId=@CursoId");         req1.input("CursoId",     sql.Int, Number(d.cursoId));     }
    if (d.coachId     && existingCols.has("CoachId"))     { setParts.push("CoachId=@CoachId");         req1.input("CoachId",     sql.Int, Number(d.coachId));     }
    if (d.modalidadId && existingCols.has("ModalidadId")) { setParts.push("ModalidadId=@ModalidadId"); req1.input("ModalidadId", sql.Int, Number(d.modalidadId)); }
    if (existingCols.has("MargenUtilidadPctDirectos"))   { setParts.push("MargenUtilidadPctDirectos=@MargenUtilidadPctDirectos");    req1.input("MargenUtilidadPctDirectos",   sql.Decimal(18,4), d.margenUtilidadPctDirectos   ?? null); }
    if (existingCols.has("MargenUtilidadDirectos"))      { setParts.push("MargenUtilidadDirectos=@MargenUtilidadDirectos");          req1.input("MargenUtilidadDirectos",      sql.Decimal(18,2), d.margenUtilidadDirectos      ?? null); }
    if (existingCols.has("MargenUtilidadPctIndirectos")) { setParts.push("MargenUtilidadPctIndirectos=@MargenUtilidadPctIndirectos"); req1.input("MargenUtilidadPctIndirectos", sql.Decimal(18,4), d.margenUtilidadPctIndirectos  ?? null); }
    if (existingCols.has("MargenUtilidadIndirectos"))    { setParts.push("MargenUtilidadIndirectos=@MargenUtilidadIndirectos");      req1.input("MargenUtilidadIndirectos",    sql.Decimal(18,2), d.margenUtilidadIndirectos    ?? null); }

    await req1.query(`UPDATE Cotizaciones SET ${setParts.join(",")} WHERE CotizacionId=@id`);

    await pool.request().input("id", sql.Int, id)
      .query("DELETE FROM CotizacionParticipantes WHERE CotizacionId=@id");
    for (const p of participantes) {
      await pool.request()
        .input("CotizacionId",   sql.Int,               id)
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

    try {
      await pool.request().input("id", sql.Int, id)
        .query("DELETE FROM CotizacionCostos WHERE CotizacionId=@id");
      for (let i = 0; i < costos.length; i++) {
        const c = costos[i];
        await pool.request()
          .input("CotizacionId",  sql.Int,           id)
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
      }
    } catch (costErr) {
      console.log("⚠️ Error actualizando costos:", costErr.message);
    }

    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ACTUALIZAR COTIZACIÓN:", err); res.status(500).json({ error: err.message }); }
});

app.post("/api/cotizaciones/:id/enviar", async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    await pool.request()
      .input("id", sql.Int, id)
      .query("UPDATE Cotizaciones SET Estado = 'Enviada' WHERE CotizacionId = @id");
    res.json({ ok: true });

    // Notificar al autorizador1
    ;(async () => {
      try {
        const cotRes = await pool.request().input("id", sql.Int, id).query(`
          SELECT c.Folio, c.TotalConGanancia, c.CreadoPor,
            cl.Nombre AS Cliente, cu.Nombre AS Curso
          FROM Cotizaciones c
          LEFT JOIN Empresas cl ON c.ClienteId = cl.EmpresaId
          LEFT JOIN Cursos cu ON c.CursoId = cu.CursoId
          WHERE c.CotizacionId = @id
        `);
        const cot = cotRes.recordset[0];
        if (!cot) return;
        const emailsAut = await getEmailsDeRol("autorizador1");
        console.log(`📧 Cotización ${cot.Folio} /enviar — autorizadores: ${emailsAut.join(',') || 'ninguno'}`);
        if (emailsAut.length) {
          await sendMail(emailsAut,
            `Nueva cotización ${cot.Folio} requiere su aprobación`,
            emailCotizacionPendiente(cot.Folio, cot.Cliente, cot.Curso, cot.TotalConGanancia, cot.CreadoPor));
          console.log(`✅ Email /enviar enviado a: ${emailsAut.join(',')}`);
        }
      } catch (e) { console.log('❌ Error email /enviar cotización:', e.message); }
    })();
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
    const soloMias = !['admin', 'autorizador1', 'autorizador2'].includes(req.usuario.rol);
    const reqOrd = pool.request();
    if (soloMias) reqOrd.input("nombre", sql.NVarChar(150), req.usuario.nombre);
    const [ordResult, aprobResult] = await Promise.all([
      reqOrd.query(`
        SELECT oc.*, u.Nombre AS UnidadNegocio, p.Nombre AS Proveedor
        FROM OrdenesCompra oc
        INNER JOIN UnidadesNegocio u ON oc.UnidadNegocioId = u.UnidadNegocioId
        INNER JOIN Proveedores p ON oc.ProveedorId = p.ProveedorId
        WHERE oc.Activo = 1 ${soloMias ? "AND oc.Creador = @nombre" : ""}
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
    const orderId   = await insertOrderWithDetails(req.body);
    const folio     = generateOrderFolio(orderId);
    const proveedor = req.body.Proveedor|| req.body.proveedor|| "";
    const total     = req.body.Total    || req.body.total    || 0;
    const creador   = req.body.Creador  || req.body.creador  || "";
    res.status(201).json({ id: orderId });
    // Notificaciones async
    Promise.all([
      getEmailsDeRol("autorizador1"),
      getEmailDeUsuario(creador),
    ]).then(([emailsAut, emailsCreador]) => {
      if (emailsAut.length) {
        console.log(`📧 OC ${folio} → autorizador1`);
        sendMail(emailsAut, `Nueva orden ${folio} requiere su autorización`, emailOrdenCreada(folio, proveedor, total));
      }
      if (emailsCreador.length) {
        console.log(`📧 OC ${folio} → creador (${creador})`);
        sendMail(emailsCreador, `Tu orden de compra ${folio} fue registrada y está pendiente de aprobación`,
          emailOCConfirmacion(folio, proveedor, total));
      }
    }).catch(() => {});
  } catch (err) { console.log("❌ ERROR CREAR ORDEN DE COMPRA:", err); res.status(500).json({ error: err.message || 'Error interno del servidor' }); }
});

app.put("/api/ordenescompra/:id", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    if (!['admin', 'jefe_mantenimiento'].includes(req.usuario.rol))
      return res.status(403).json({ error: 'Sin permisos para editar órdenes de compra' });

    const orderId = Number(req.params.id);
    const { ProveedorId, UnidadNegocioId, Tipo, Destino, Observaciones, ConIva, Total, Subtotal, Iva, LineItems, Proveedor } = req.body;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      await new sql.Request(transaction)
        .input('id',    sql.Int,           orderId)
        .input('prov',  sql.Int,           Number(ProveedorId))
        .input('un',    sql.Int,           Number(UnidadNegocioId))
        .input('tipo',  sql.NVarChar(50),  Tipo || 'compras')
        .input('dest',  sql.NVarChar(200), Destino || null)
        .input('obs',   sql.NVarChar(sql.MAX), Observaciones || null)
        .input('iva',   sql.Bit,           ConIva ? 1 : 0)
        .input('sub',   sql.Decimal(18,2), Number(Subtotal) || 0)
        .input('ivaM',  sql.Decimal(18,2), Number(Iva) || 0)
        .input('tot',   sql.Decimal(18,2), Number(Total) || 0)
        .query(`UPDATE OrdenesCompra SET
          ProveedorId=@prov, UnidadNegocioId=@un, Tipo=@tipo,
          Destino=@dest, Observaciones=@obs, ConIva=@iva,
          Subtotal=@sub, IVA=@ivaM, Total=@tot,
          Rechazado=0, RechazadoPor=NULL, MotivoRechazo=NULL, FechaRechazo=NULL
          WHERE OrdenCompraId=@id`);

      await new sql.Request(transaction)
        .input('id', sql.Int, orderId)
        .query(`UPDATE OrdenesCompraAprobaciones
                SET Aprobado=0, AprobadoPor=NULL, FechaAprobacion=NULL
                WHERE OrdenCompraId=@id`);

      await new sql.Request(transaction)
        .input('id', sql.Int, orderId)
        .query('DELETE FROM OrdenesCompraLineas WHERE OrdenCompraId=@id');

      for (let i = 0; i < (LineItems || []).length; i++) {
        const l = LineItems[i];
        const cant = Number(l.Cantidad) || 0;
        const pu   = Number(l.PrecioUnitario) || 0;
        await new sql.Request(transaction)
          .input('ocId', sql.Int,           orderId)
          .input('desc', sql.NVarChar(500), l.Descripcion || '')
          .input('cant', sql.Decimal(10,4), cant)
          .input('um',   sql.NVarChar(50),  l.UnidadMedida || '')
          .input('pu',   sql.Decimal(18,4), pu)
          .input('sub',  sql.Decimal(18,2), Number((cant * pu).toFixed(2)))
          .input('pid',  sql.Int,           l.ProductoId || null)
          .input('lin',  sql.Int,           i + 1)
          .query(`INSERT INTO OrdenesCompraLineas
                    (OrdenCompraId,Descripcion,Cantidad,UnidadMedida,PrecioUnitario,Subtotal,ProductoId,OrdenLinea)
                  VALUES(@ocId,@desc,@cant,@um,@pu,@sub,@pid,@lin)`);
      }

      await transaction.commit();
      res.json({ ok: true });

      // Notificar que la OC fue modificada y vuelve a autorización
      const ocRes = await pool.request().input('id', sql.Int, orderId)
        .query('SELECT Folio FROM OrdenesCompra WHERE OrdenCompraId=@id');
      const folio = ocRes.recordset[0]?.Folio || '';
      getEmailsDeRol('autorizador1').then(emails => {
        if (emails.length) sendMail(emails,
          `OC ${folio} modificada — requiere nueva autorización`,
          emailOrdenCreada(folio, Proveedor || '', Total));
      }).catch(() => {});

    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/ordenescompra/:id", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { rol } = req.usuario;
    if (rol !== 'admin' && rol !== 'autorizador1' && rol !== 'autorizador2') {
      return res.status(403).json({ error: 'Sin permisos para eliminar órdenes de compra' });
    }
    await pool.request()
      .input("id", sql.Int, req.params.id)
      .query("UPDATE dbo.OrdenesCompra SET Activo = 0 WHERE OrdenCompraId = @id");
    res.sendStatus(204);
  } catch (err) { console.log("❌ ERROR ELIMINAR OC:", err); res.status(500).json({ error: err.message }); }
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
      SELECT oc.Folio, oc.Total, oc.Creador, p.Nombre AS Proveedor
      FROM OrdenesCompra oc INNER JOIN Proveedores p ON oc.ProveedorId=p.ProveedorId
      WHERE oc.OrdenCompraId=@id
    `);
    const order = orderRes.recordset[0];
    if (order) {
      if (paso === 1) {
        getEmailsDeRol("autorizador2").then((emails) => {
          if (emails.length)
            sendMail(emails, `Orden ${order.Folio} aprobada — requiere su autorización`,
              emailPasoAprobado(order.Folio, order.Proveedor, order.Total, 1));
        }).catch(() => {});
      } else if (paso === 2) {
        getEmailDeUsuario(order.Creador).then((emailsCreador) => {
          if (emailsCreador.length) {
            console.log(`📧 OC ${order.Folio} completamente aprobada → creador (${order.Creador})`);
            sendMail(emailsCreador, `Tu orden de compra ${order.Folio} fue aprobada`,
              emailOCResultado(order.Folio, order.Proveedor, order.Total, true, aprobador, null));
          }
        }).catch(() => {});
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

    // Notificar (fire-and-forget — fuera del try/catch principal para evitar "headers already sent")
    ;(async () => {
      try {
        const orderRes = await pool.request().input("id", sql.Int, orderId).query(`
          SELECT oc.Folio, oc.Total, oc.Creador, p.Nombre AS Proveedor
          FROM OrdenesCompra oc INNER JOIN Proveedores p ON oc.ProveedorId=p.ProveedorId
          WHERE oc.OrdenCompraId=@id
        `);
        const order = orderRes.recordset[0];
        if (!order) return;
        const emailsCreador = await getEmailDeUsuario(order.Creador);
        if (emailsCreador.length) {
          console.log(`📧 OC ${order.Folio} rechazada → creador (${order.Creador})`);
          sendMail(emailsCreador, `Tu orden de compra ${order.Folio} fue rechazada`,
            emailOCResultado(order.Folio, order.Proveedor, order.Total, false, aprobador, motivo));
        }
      } catch(e) { console.log('Email rechazo OC:', e.message); }
    })();
  } catch (err) {
    console.log("❌ ERROR RECHAZAR ORDEN:", err);
    res.status(500).json({ error: err.message || "Error al rechazar" });
  }
});

// OCs aprobadas y pendientes de recepción (para mantenimiento)
app.get("/api/ordenescompra/pendientes-recepcion", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const rolesPermitidos = ['admin', 'jefe_mantenimiento', 'mantenimiento'];
    if (!rolesPermitidos.includes(req.usuario.rol))
      return res.status(403).json({ error: 'Sin permisos' });

    const ocsRes = await pool.request().query(`
      SELECT oc.OrdenCompraId, oc.Folio, oc.Fecha, oc.Total, oc.Tipo,
             p.Nombre AS Proveedor
      FROM OrdenesCompra oc
      INNER JOIN Proveedores p ON oc.ProveedorId = p.ProveedorId
      WHERE oc.Activo = 1
        AND ISNULL(oc.Recepcionada, 0) = 0
        AND ISNULL(oc.Rechazado, 0) = 0
        AND (SELECT COUNT(*) FROM OrdenesCompraAprobaciones a
             WHERE a.OrdenCompraId = oc.OrdenCompraId AND a.Aprobado = 0) = 0
        AND (SELECT COUNT(*) FROM OrdenesCompraAprobaciones a
             WHERE a.OrdenCompraId = oc.OrdenCompraId) > 0
      ORDER BY oc.Fecha DESC
    `);

    const ocs = ocsRes.recordset;
    if (!ocs.length) return res.json([]);

    const ids = ocs.map(o => o.OrdenCompraId).join(',');
    const lineasRes = await pool.request().query(`
      SELECT l.OrdenCompraLineaId, l.OrdenCompraId, l.Descripcion, l.Cantidad,
             l.ProductoId, i.NombreProducto, i.UnidadMedida
      FROM OrdenesCompraLineas l
      LEFT JOIN Inventario i ON l.ProductoId = i.ProductoId
      WHERE l.OrdenCompraId IN (${ids})
      ORDER BY l.OrdenCompraId, l.OrdenLinea, l.OrdenCompraLineaId
    `);

    const lineasMap = {};
    for (const l of lineasRes.recordset) {
      if (!lineasMap[l.OrdenCompraId]) lineasMap[l.OrdenCompraId] = [];
      lineasMap[l.OrdenCompraId].push(l);
    }
    res.json(ocs.map(o => ({ ...o, Lineas: lineasMap[o.OrdenCompraId] || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RECEPCIÓN DE ORDEN DE COMPRA ────────────────────────────────────────────
app.post("/api/ordenescompra/:id/recepcion", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const orderId = Number(req.params.id);
    const { lineas, recibidoPor } = req.body; // lineas: [{lineaId, cantidadRecibida, productoId}]
    if (!Array.isArray(lineas) || !lineas.length)
      return res.status(400).json({ error: "Se requiere el arreglo de lineas" });

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      for (const l of lineas) {
        const cant = Number(l.cantidadRecibida || 0);
        await new sql.Request(transaction)
          .input("cant", sql.Decimal(10,2), cant)
          .input("lid",  sql.Int, Number(l.lineaId))
          .query("UPDATE OrdenesCompraLineas SET CantidadRecibida=@cant WHERE OrdenCompraLineaId=@lid");

        if (l.productoId && cant > 0) {
          const prodRes = await new sql.Request(transaction)
            .input("pid", sql.Int, Number(l.productoId))
            .query("SELECT CantidadReal FROM Inventario WHERE ProductoId=@pid");
          if (prodRes.recordset.length) {
            const anterior = Number(prodRes.recordset[0].CantidadReal);
            const nueva    = anterior + cant;
            await new sql.Request(transaction)
              .input("pid",  sql.Int,          Number(l.productoId))
              .input("cant", sql.Decimal(10,2), nueva)
              .query("UPDATE Inventario SET CantidadReal=@cant WHERE ProductoId=@pid");
            await new sql.Request(transaction)
              .input("pid",  sql.Int,          Number(l.productoId))
              .input("cant", sql.Decimal(10,2), cant)
              .input("ant",  sql.Decimal(10,2), anterior)
              .input("ocId", sql.Int,           orderId)
              .input("usr",  sql.NVarChar(150), recibidoPor || "")
              .query(`INSERT INTO InventarioMovimientos
                        (ProductoId,TipoMovimiento,Cantidad,CantidadAnterior,OrdenCompraId,Usuario)
                      VALUES(@pid,'ingreso',@cant,@ant,@ocId,@usr)`);
          }
        }
      }
      await new sql.Request(transaction)
        .input("id",  sql.Int,          orderId)
        .input("por", sql.NVarChar(150), recibidoPor || "")
        .query("UPDATE OrdenesCompra SET Recepcionada=1, FechaRecepcion=SYSUTCDATETIME(), RecibidoPor=@por WHERE OrdenCompraId=@id");
      await transaction.commit();
      res.json({ ok: true });
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  } catch (err) {
    console.log("❌ ERROR RECEPCIÓN OC:", err);
    res.status(500).json({ error: err.message || "Error al registrar recepción" });
  }
});

// ─── ÁREAS DE CONSUMO ─────────────────────────────────────────────────────────
app.get("/api/areas-consumo", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query("SELECT * FROM AreasConsumo WHERE Activo=1 ORDER BY Nombre");
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/areas-consumo", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Nombre } = req.body;
    if (!Nombre?.trim()) return res.status(400).json({ error: "Nombre requerido" });
    const r = await pool.request()
      .input("n", sql.NVarChar(200), Nombre.trim())
      .query("INSERT INTO AreasConsumo (Nombre) OUTPUT INSERTED.AreaConsumoId VALUES (@n)");
    res.json({ AreaConsumoId: r.recordset[0].AreaConsumoId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/api/areas-consumo/:id", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Nombre } = req.body;
    await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .input("n",  sql.NVarChar(200), Nombre?.trim() || "")
      .query("UPDATE AreasConsumo SET Nombre=@n WHERE AreaConsumoId=@id");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/areas-consumo/:id", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    await pool.request()
      .input("id", sql.Int, Number(req.params.id))
      .query("UPDATE AreasConsumo SET Activo=0 WHERE AreaConsumoId=@id");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CONSUMOS DE LIMPIEZA ────────────────────────────────────────────────────
app.get("/api/consumos", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const soloMios = !['admin', 'jefe_mantenimiento'].includes(req.usuario.rol);
    const req2 = pool.request();
    if (soloMios) req2.input("usr", sql.NVarChar(150), req.usuario.nombre);
    const r = await req2.query(`
      SELECT c.ConsumoId, c.Cantidad, c.Usuario, c.Observaciones, c.Fecha,
             i.NombreProducto, i.UnidadMedida,
             a.Nombre AS Area
      FROM ConsumosLimpieza c
      INNER JOIN Inventario i ON c.ProductoId = i.ProductoId
      LEFT JOIN  AreasConsumo a ON c.AreaConsumoId = a.AreaConsumoId
      ${soloMios ? "WHERE c.Usuario = @usr" : ""}
      ORDER BY c.Fecha DESC
    `);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/consumos", autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { productoId, areaConsumoId, cantidad, observaciones } = req.body;
    const cant = Number(cantidad);
    if (!productoId || !cant || cant <= 0)
      return res.status(400).json({ error: "productoId y cantidad requeridos" });

    const transaction = new sql.Transaction(pool);
    await transaction.begin();
    try {
      const prodRes = await new sql.Request(transaction)
        .input("pid", sql.Int, Number(productoId))
        .query("SELECT CantidadReal FROM Inventario WHERE ProductoId=@pid");
      if (!prodRes.recordset.length) { await transaction.rollback(); return res.status(404).json({ error: "Producto no encontrado" }); }
      const anterior = Number(prodRes.recordset[0].CantidadReal);
      if (anterior < cant) { await transaction.rollback(); return res.status(400).json({ error: "Stock insuficiente" }); }
      const nueva = anterior - cant;

      await new sql.Request(transaction)
        .input("pid",  sql.Int,          Number(productoId))
        .input("cant", sql.Decimal(10,2), nueva)
        .query("UPDATE Inventario SET CantidadReal=@cant WHERE ProductoId=@pid");

      await new sql.Request(transaction)
        .input("pid",  sql.Int,          Number(productoId))
        .input("aid",  sql.Int,          areaConsumoId ? Number(areaConsumoId) : null)
        .input("cant", sql.Decimal(10,2), cant)
        .input("usr",  sql.NVarChar(150), req.usuario.nombre)
        .input("obs",  sql.NVarChar(500), observaciones || null)
        .query(`INSERT INTO ConsumosLimpieza (ProductoId, AreaConsumoId, Cantidad, Usuario, Observaciones)
                VALUES (@pid, @aid, @cant, @usr, @obs)`);

      await new sql.Request(transaction)
        .input("pid",  sql.Int,          Number(productoId))
        .input("cant", sql.Decimal(10,2), cant)
        .input("ant",  sql.Decimal(10,2), anterior)
        .input("usr",  sql.NVarChar(150), req.usuario.nombre)
        .query(`INSERT INTO InventarioMovimientos (ProductoId,TipoMovimiento,Cantidad,CantidadAnterior,Usuario)
                VALUES (@pid,'consumo',@cant,@ant,@usr)`);

      await transaction.commit();
      res.json({ ok: true, stockNuevo: nueva });
    } catch (err) { await transaction.rollback(); throw err; }
  } catch (err) {
    console.log("❌ ERROR CONSUMO:", err);
    res.status(500).json({ error: err.message || "Error al registrar consumo" });
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
      { lbl: order.ConIva !== false ? "IVA 16%" : "Sin IVA", val: order.ConIva !== false ? fmtMXN(order.Iva) : "—", bg: "#f9fafb", fg: order.ConIva !== false ? "#111827" : "#9ca3af", bold: false },
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

// ─── ÓRDENES DE MANTENIMIENTO ─────────────────────────────────────────────────
app.get('/api/ordenes-mantenimiento', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query(`
      SELECT om.*, oc.Folio AS FolioOC
      FROM OrdenesMantenimiento om
      LEFT JOIN OrdenesCompra oc ON om.OrdenCompraId = oc.OrdenCompraId
      WHERE om.Activo = 1
      ORDER BY om.FechaCreacion DESC
    `);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/ordenes-mantenimiento/:id', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const omRes = await pool.request().input('id', sql.Int, id).query(`
      SELECT om.*, oc.Folio AS FolioOC
      FROM OrdenesMantenimiento om
      LEFT JOIN OrdenesCompra oc ON om.OrdenCompraId = oc.OrdenCompraId
      WHERE om.OrdenMantenimientoId = @id AND om.Activo = 1
    `);
    if (!omRes.recordset.length) return res.status(404).json({ error: 'No encontrada' });
    const mat = await pool.request().input('id', sql.Int, id).query(`
      SELECT * FROM OrdenesMantenimientoMateriales WHERE OrdenMantenimientoId = @id
    `);
    res.json({ orden: omRes.recordset[0], materiales: mat.recordset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/ordenes-mantenimiento', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    const r = await pool.request()
      .input('Departamento',     sql.NVarChar(200),  d.departamento     || null)
      .input('FechaReporte',     sql.Date,            d.fechaReporte     || null)
      .input('NombreSolicita',   sql.NVarChar(300),   d.nombreSolicita   || null)
      .input('Puesto',           sql.NVarChar(200),   d.puesto           || null)
      .input('Equipo',           sql.NVarChar(200),   d.equipo           || null)
      .input('Codigo',           sql.NVarChar(100),   d.codigo           || null)
      .input('RazonOrden',       sql.NVarChar(100),   d.razonOrden       || null)
      .input('DescripcionFalla', sql.NVarChar(sql.MAX), d.descripcionFalla || null)
      .input('CreadoPor',        sql.NVarChar(150),   d.creadoPor        || null)
      .query(`
        INSERT INTO OrdenesMantenimiento
          (Departamento,FechaReporte,NombreSolicita,Puesto,Equipo,Codigo,RazonOrden,DescripcionFalla,CreadoPor,Estado)
        VALUES
          (@Departamento,@FechaReporte,@NombreSolicita,@Puesto,@Equipo,@Codigo,@RazonOrden,@DescripcionFalla,@CreadoPor,'Pendiente');
        SELECT SCOPE_IDENTITY() AS id;
      `);
    const newId = r.recordset[0].id;
    const year  = new Date().getFullYear();
    const folio = `OM-${year}-${String(newId).padStart(6, '0')}`;
    await pool.request().input('folio', sql.NVarChar(50), folio).input('id', sql.Int, newId)
      .query('UPDATE OrdenesMantenimiento SET Folio=@folio WHERE OrdenMantenimientoId=@id');
    res.json({ id: newId, folio });
    // Notificar a personal de mantenimiento (fire-and-forget)
    getEmailsPorRoles(['mantenimiento', 'jefe_mantenimiento']).then(emails => {
      if (emails.length)
        sendMail(emails, `Nueva Orden de Mantenimiento — ${folio}`,
          emailOMCreada(folio, d.equipo, d.departamento, d.razonOrden, d.nombreSolicita));
    }).catch(() => {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/ordenes-mantenimiento/:id', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const d = req.body;
    await pool.request()
      .input('id',                      sql.Int,              id)
      .input('TipoFalla',               sql.NVarChar(100),    d.tipoFalla               || null)
      .input('FechaTerminacion',        sql.Date,             d.fechaTerminacion        || null)
      .input('DescripcionMantenimiento',sql.NVarChar(sql.MAX),d.descripcionMantenimiento|| null)
      .input('TecnicoResponsable',      sql.NVarChar(300),    d.tecnicoResponsable      || null)
      .input('UsuarioEquipo',           sql.NVarChar(300),    d.usuarioEquipo           || null)
      .input('Estado',                  sql.NVarChar(50),     d.estado                  || 'En proceso')
      .query(`
        UPDATE OrdenesMantenimiento SET
          TipoFalla=@TipoFalla, FechaTerminacion=@FechaTerminacion,
          DescripcionMantenimiento=@DescripcionMantenimiento,
          TecnicoResponsable=@TecnicoResponsable, UsuarioEquipo=@UsuarioEquipo,
          Estado=@Estado
        WHERE OrdenMantenimientoId=@id
      `);
    // Replace materiales
    await pool.request().input('id', sql.Int, id)
      .query('DELETE FROM OrdenesMantenimientoMateriales WHERE OrdenMantenimientoId=@id');
    const materiales = d.materiales || [];
    for (const m of materiales) {
      if (!m.material?.trim()) continue;
      await pool.request()
        .input('oid', sql.Int, id)
        .input('mat', sql.NVarChar(500), m.material)
        .input('qty', sql.NVarChar(100), m.cantidad || '')
        .input('pid', sql.Int, m.productoId ? Number(m.productoId) : null)
        .query('INSERT INTO OrdenesMantenimientoMateriales (OrdenMantenimientoId,Material,Cantidad,ProductoId) VALUES(@oid,@mat,@qty,@pid)');

      // Descontar del inventario si se marca como Completada
      if (m.productoId && d.estado === 'Completada') {
        const cantConsumo = parseFloat(m.cantidad) || 0;
        if (cantConsumo > 0) {
          const prodRes = await pool.request()
            .input('pid', sql.Int, Number(m.productoId))
            .query('SELECT CantidadReal FROM Inventario WHERE ProductoId=@pid');
          if (prodRes.recordset.length) {
            const cantAnterior = Number(prodRes.recordset[0].CantidadReal);
            const cantNueva    = Math.max(0, cantAnterior - cantConsumo);
            await pool.request()
              .input('pid',  sql.Int,           Number(m.productoId))
              .input('cant', sql.Decimal(10,2),  cantNueva)
              .query('UPDATE Inventario SET CantidadReal=@cant WHERE ProductoId=@pid');
            await pool.request()
              .input('pid',  sql.Int,           Number(m.productoId))
              .input('cant', sql.Decimal(10,2),  cantConsumo)
              .input('ant',  sql.Decimal(10,2),  cantAnterior)
              .input('oid',  sql.Int,            id)
              .input('usr',  sql.NVarChar(150),  req.usuario?.nombre || '')
              .query(`INSERT INTO InventarioMovimientos
                        (ProductoId,TipoMovimiento,Cantidad,CantidadAnterior,OrdenMantenimientoId,Usuario)
                      VALUES(@pid,'consumo',@cant,@ant,@oid,@usr)`);
          }
        }
      }
    }
    res.json({ ok: true });
    // Notificar al jefe de mantenimiento si la orden se completó (fire-and-forget)
    if (d.estado === 'Completada') {
      (async () => {
        try {
          const omRes = await pool.request().input('id', sql.Int, id)
            .query('SELECT Folio, Equipo FROM OrdenesMantenimiento WHERE OrdenMantenimientoId=@id');
          if (!omRes.recordset.length) return;
          const om = omRes.recordset[0];
          const emails = await getEmailsPorRoles(['jefe_mantenimiento']);
          if (emails.length)
            sendMail(emails, `Orden ${om.Folio} completada`,
              emailOMCompletada(om.Folio, om.Equipo, d.tecnicoResponsable, d.tipoFalla,
                d.descripcionMantenimiento, (d.materiales || []).filter(m => m.material?.trim())));
        } catch(e) { console.log('Email OM completada:', e.message); }
      })();
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventario ────────────────────────────────────────────────────────────────
app.get('/api/inventario', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query(`
      SELECT i.*,
        CASE WHEN i.CantidadReal <= 0          THEN 'agotado'
             WHEN i.CantidadReal < i.CantidadMinima THEN 'bajo'
             ELSE 'ok' END AS EstadoStock
      FROM Inventario i
      ORDER BY i.NombreProducto
    `);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/inventario/dashboard', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const stats = await pool.request().query(`
      SELECT
        COUNT(*)                                                               AS TotalProductos,
        SUM(CASE WHEN Activo=1 THEN 1 ELSE 0 END)                            AS ProductosActivos,
        SUM(CASE WHEN CantidadReal<=0 AND Activo=1 THEN 1 ELSE 0 END)        AS Agotados,
        SUM(CASE WHEN CantidadReal>0 AND CantidadReal<CantidadMinima AND Activo=1 THEN 1 ELSE 0 END) AS StockBajo,
        SUM(CantidadReal * ISNULL(Precio,0))                                 AS ValorTotal
      FROM Inventario
    `);
    const movs = await pool.request().query(`
      SELECT TOP 15 m.*, i.NombreProducto, i.UnidadMedida
      FROM InventarioMovimientos m
      JOIN Inventario i ON i.ProductoId = m.ProductoId
      ORDER BY m.Fecha DESC
    `);
    res.json({ stats: stats.recordset[0], movimientos: movs.recordset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventario', autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    const r = await pool.request()
      .input('NombreProducto', sql.NVarChar(300),  d.nombreProducto || d.NombreProducto)
      .input('Descripcion',    sql.NVarChar(500),   d.descripcion    || d.Descripcion    || null)
      .input('UnidadMedida',   sql.NVarChar(100),   d.unidadMedida   || d.UnidadMedida   || 'pza')
      .input('CantidadMinima', sql.Decimal(10,2),   Number(d.cantidadMinima ?? d.CantidadMinima ?? 0))
      .input('CantidadReal',   sql.Decimal(10,2),   Number(d.cantidadReal   ?? d.CantidadReal   ?? 0))
      .input('Precio',         sql.Decimal(18,2),   Number(d.precio         ?? d.Precio         ?? 0))
      .query(`
        INSERT INTO Inventario (NombreProducto,Descripcion,UnidadMedida,CantidadMinima,CantidadReal,Precio)
        VALUES (@NombreProducto,@Descripcion,@UnidadMedida,@CantidadMinima,@CantidadReal,@Precio);
        SELECT SCOPE_IDENTITY() AS id;
      `);
    const newId   = r.recordset[0].id;
    const cantIni = Number(d.cantidadReal ?? d.CantidadReal ?? 0);
    if (cantIni > 0) {
      await pool.request()
        .input('pid',  sql.Int,           newId)
        .input('cant', sql.Decimal(10,2),  cantIni)
        .input('usr',  sql.NVarChar(150),  req.usuario?.nombre || '')
        .query(`INSERT INTO InventarioMovimientos (ProductoId,TipoMovimiento,Cantidad,CantidadAnterior,Usuario,Referencia)
                VALUES(@pid,'ingreso',@cant,0,@usr,'Stock inicial')`);
    }
    res.json({ id: newId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/inventario/:id', autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const d  = req.body;
    await pool.request()
      .input('id',             sql.Int,           id)
      .input('NombreProducto', sql.NVarChar(300),  d.nombreProducto || d.NombreProducto)
      .input('Descripcion',    sql.NVarChar(500),   d.descripcion    || d.Descripcion    || null)
      .input('UnidadMedida',   sql.NVarChar(100),   d.unidadMedida   || d.UnidadMedida   || 'pza')
      .input('CantidadMinima', sql.Decimal(10,2),   Number(d.cantidadMinima ?? d.CantidadMinima ?? 0))
      .input('Precio',         sql.Decimal(18,2),   Number(d.precio         ?? d.Precio         ?? 0))
      .input('Activo',         sql.Bit,             d.activo !== undefined ? (d.activo ? 1 : 0) : 1)
      .query(`UPDATE Inventario SET
                NombreProducto=@NombreProducto, Descripcion=@Descripcion,
                UnidadMedida=@UnidadMedida, CantidadMinima=@CantidadMinima,
                Precio=@Precio, Activo=@Activo
              WHERE ProductoId=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/inventario/:id/ajuste', autenticar, soloAdmin, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id  = Number(req.params.id);
    const { cantidad, tipo, referencia } = req.body;
    const cur = await pool.request().input('id', sql.Int, id)
      .query('SELECT CantidadReal FROM Inventario WHERE ProductoId=@id');
    if (!cur.recordset.length) return res.status(404).json({ error: 'Producto no encontrado' });
    const cantAnterior = Number(cur.recordset[0].CantidadReal);
    const cantNueva    = tipo === 'ingreso' ? cantAnterior + Number(cantidad) : Number(cantidad);
    await pool.request()
      .input('id',   sql.Int,           id)
      .input('cant', sql.Decimal(10,2),  Math.max(0, cantNueva))
      .query('UPDATE Inventario SET CantidadReal=@cant WHERE ProductoId=@id');
    await pool.request()
      .input('pid',  sql.Int,           id)
      .input('tipo', sql.NVarChar(50),   tipo || 'ajuste')
      .input('cant', sql.Decimal(10,2),  Number(cantidad))
      .input('ant',  sql.Decimal(10,2),  cantAnterior)
      .input('usr',  sql.NVarChar(150),  req.usuario?.nombre || '')
      .input('ref',  sql.NVarChar(300),  referencia || null)
      .query(`INSERT INTO InventarioMovimientos (ProductoId,TipoMovimiento,Cantidad,CantidadAnterior,Usuario,Referencia)
              VALUES(@pid,@tipo,@cant,@ant,@usr,@ref)`);
    res.json({ ok: true, cantidadReal: Math.max(0, cantNueva) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── MÓDULO DE SEGURIDAD ─────────────────────────────────────────────────────

function generateSegFolio(prefix, id) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(id).padStart(6, '0')}`;
}

// ── Catálogo: Vehículos ───────────────────────────────────────────────────────

app.get('/api/seguridad/vehiculos', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query('SELECT * FROM Vehiculos WHERE Activo=1 ORDER BY Marca, Modelo');
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/vehiculos', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    const r = await pool.request()
      .input('Marca',     sql.NVarChar(100), d.Marca   || '')
      .input('Modelo',    sql.NVarChar(100), d.Modelo  || '')
      .input('Placa',     sql.NVarChar(20),  d.Placa   || '')
      .input('Año',       sql.Int,           d.Año     ? Number(d.Año)      : null)
      .input('Color',     sql.NVarChar(50),  d.Color   || null)
      .input('Capacidad', sql.Int,           d.Capacidad ? Number(d.Capacidad) : null)
      .query('INSERT INTO Vehiculos (Marca,Modelo,Placa,Año,Color,Capacidad) VALUES (@Marca,@Modelo,@Placa,@Año,@Color,@Capacidad); SELECT SCOPE_IDENTITY() AS id');
    res.json({ ok: true, id: r.recordset[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/vehiculos/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    await pool.request()
      .input('id',        sql.Int,           Number(req.params.id))
      .input('Marca',     sql.NVarChar(100), d.Marca   || '')
      .input('Modelo',    sql.NVarChar(100), d.Modelo  || '')
      .input('Placa',     sql.NVarChar(20),  d.Placa   || '')
      .input('Año',       sql.Int,           d.Año     ? Number(d.Año)      : null)
      .input('Color',     sql.NVarChar(50),  d.Color   || null)
      .input('Capacidad', sql.Int,           d.Capacidad ? Number(d.Capacidad) : null)
      .input('Activo',    sql.Bit,           d.Activo !== false ? 1 : 0)
      .query('UPDATE Vehiculos SET Marca=@Marca,Modelo=@Modelo,Placa=@Placa,Año=@Año,Color=@Color,Capacidad=@Capacidad,Activo=@Activo WHERE VehiculoId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Catálogo: Extintores ──────────────────────────────────────────────────────

app.get('/api/seguridad/extintores', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query(`
      SELECT e.*,
        (SELECT TOP 1 FechaRevision FROM RevisionesExtintores WHERE ExtintorId=e.ExtintorId ORDER BY FechaRevision DESC) AS UltimaRevision,
        (SELECT TOP 1 CondicionFisica FROM RevisionesExtintores WHERE ExtintorId=e.ExtintorId ORDER BY FechaRevision DESC) AS UltimaCondicion
      FROM Extintores e WHERE e.Activo=1 ORDER BY e.Codigo
    `);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/extintores', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    const r = await pool.request()
      .input('Codigo',           sql.NVarChar(50),  d.Codigo || '')
      .input('Tipo',             sql.NVarChar(50),  d.Tipo   || null)
      .input('Ubicacion',        sql.NVarChar(300), d.Ubicacion || null)
      .input('FechaVencimiento', sql.Date,          d.FechaVencimiento || null)
      .query('INSERT INTO Extintores (Codigo,Tipo,Ubicacion,FechaVencimiento) VALUES (@Codigo,@Tipo,@Ubicacion,@FechaVencimiento); SELECT SCOPE_IDENTITY() AS id');
    res.json({ ok: true, id: r.recordset[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/extintores/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    await pool.request()
      .input('id',               sql.Int,           Number(req.params.id))
      .input('Codigo',           sql.NVarChar(50),  d.Codigo || '')
      .input('Tipo',             sql.NVarChar(50),  d.Tipo   || null)
      .input('Ubicacion',        sql.NVarChar(300), d.Ubicacion || null)
      .input('FechaVencimiento', sql.Date,          d.FechaVencimiento || null)
      .input('Activo',           sql.Bit,           d.Activo !== false ? 1 : 0)
      .query('UPDATE Extintores SET Codigo=@Codigo,Tipo=@Tipo,Ubicacion=@Ubicacion,FechaVencimiento=@FechaVencimiento,Activo=@Activo WHERE ExtintorId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Catálogo: Puntos y Áreas de Revisión ─────────────────────────────────────

app.get('/api/seguridad/puntos-revision', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const puntos = await pool.request().query('SELECT * FROM PuntosRevision WHERE Activo=1 ORDER BY Nombre');
    const areas  = await pool.request().query('SELECT * FROM AreasRevision WHERE Activo=1 ORDER BY Nombre');
    const data = puntos.recordset.map(p => ({
      ...p,
      areas: areas.recordset.filter(a => a.PuntoRevisionId === p.PuntoRevisionId),
    }));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/puntos-revision', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Nombre, Descripcion } = req.body;
    const r = await pool.request()
      .input('Nombre',      sql.NVarChar(200), Nombre || '')
      .input('Descripcion', sql.NVarChar(500), Descripcion || null)
      .query('INSERT INTO PuntosRevision (Nombre,Descripcion) VALUES (@Nombre,@Descripcion); SELECT SCOPE_IDENTITY() AS id');
    res.json({ ok: true, id: r.recordset[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/puntos-revision/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Nombre, Descripcion, Activo } = req.body;
    await pool.request()
      .input('id',          sql.Int,           Number(req.params.id))
      .input('Nombre',      sql.NVarChar(200), Nombre || '')
      .input('Descripcion', sql.NVarChar(500), Descripcion || null)
      .input('Activo',      sql.Bit,           Activo !== false ? 1 : 0)
      .query('UPDATE PuntosRevision SET Nombre=@Nombre,Descripcion=@Descripcion,Activo=@Activo WHERE PuntoRevisionId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/puntos-revision/:id/areas', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Nombre } = req.body;
    const r = await pool.request()
      .input('PuntoRevisionId', sql.Int,           Number(req.params.id))
      .input('Nombre',          sql.NVarChar(200), Nombre || '')
      .query('INSERT INTO AreasRevision (PuntoRevisionId,Nombre) VALUES (@PuntoRevisionId,@Nombre); SELECT SCOPE_IDENTITY() AS id');
    res.json({ ok: true, id: r.recordset[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/areas/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Nombre, Activo } = req.body;
    await pool.request()
      .input('id',     sql.Int,           Number(req.params.id))
      .input('Nombre', sql.NVarChar(200), Nombre || '')
      .input('Activo', sql.Bit,           Activo !== false ? 1 : 0)
      .query('UPDATE AreasRevision SET Nombre=@Nombre,Activo=@Activo WHERE AreaRevisionId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rondines ──────────────────────────────────────────────────────────────────

app.get('/api/seguridad/rondines', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request().query(`
      SELECT r.*,
        (SELECT COUNT(*) FROM RondinesRegistros WHERE RondinId=r.RondinId) AS TotalAreas,
        (SELECT COUNT(*) FROM RondinesRegistros WHERE RondinId=r.RondinId AND Revisado=1) AS AreasRevisadas,
        (SELECT COUNT(*) FROM RondinesRegistros WHERE RondinId=r.RondinId AND TieneIncidencia=1) AS TotalIncidencias
      FROM Rondines r ORDER BY r.FechaCreacion DESC
    `);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/rondines', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const guardia = req.usuario?.nombre || '';
    const r = await pool.request()
      .input('Guardia',     sql.NVarChar(200), guardia)
      .input('FechaInicio', sql.DateTime2,     new Date())
      .query(`INSERT INTO Rondines (Guardia,FechaInicio,Estado) VALUES (@Guardia,@FechaInicio,'en_curso'); SELECT SCOPE_IDENTITY() AS id`);
    const rondinId = r.recordset[0].id;
    const folio    = generateSegFolio('RND', rondinId);
    await pool.request()
      .input('id',    sql.Int,          rondinId)
      .input('Folio', sql.NVarChar(50), folio)
      .query('UPDATE Rondines SET Folio=@Folio WHERE RondinId=@id');

    const puntos = await pool.request().query(`
      SELECT ar.AreaRevisionId, ar.PuntoRevisionId
      FROM AreasRevision ar
      JOIN PuntosRevision pr ON ar.PuntoRevisionId=pr.PuntoRevisionId
      WHERE ar.Activo=1 AND pr.Activo=1
    `);
    for (const p of puntos.recordset) {
      await pool.request()
        .input('RondinId',        sql.Int, rondinId)
        .input('PuntoRevisionId', sql.Int, p.PuntoRevisionId)
        .input('AreaRevisionId',  sql.Int, p.AreaRevisionId)
        .query('INSERT INTO RondinesRegistros (RondinId,PuntoRevisionId,AreaRevisionId,Revisado) VALUES (@RondinId,@PuntoRevisionId,@AreaRevisionId,0)');
    }
    res.json({ ok: true, rondinId, folio });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/seguridad/rondines/:id', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const r  = await pool.request().input('id', sql.Int, id).query('SELECT * FROM Rondines WHERE RondinId=@id');
    if (!r.recordset.length) return res.status(404).json({ error: 'Rondín no encontrado' });
    const registros = await pool.request().input('id', sql.Int, id).query(`
      SELECT rr.*, pr.Nombre AS PuntoNombre, ar.Nombre AS AreaNombre
      FROM RondinesRegistros rr
      LEFT JOIN PuntosRevision pr ON rr.PuntoRevisionId=pr.PuntoRevisionId
      LEFT JOIN AreasRevision  ar ON rr.AreaRevisionId=ar.AreaRevisionId
      WHERE rr.RondinId=@id
      ORDER BY pr.Nombre, ar.Nombre
    `);
    res.json({ ...r.recordset[0], registros: registros.recordset });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/rondines/:id/registro/:registroId', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const rondinId   = Number(req.params.id);
    const registroId = Number(req.params.registroId);
    const { TieneIncidencia, NivelSeveridad, DescripcionIncidencia, RequiereMantenimiento, FotoUrl } = req.body;
    await pool.request()
      .input('id',                    sql.Int,            registroId)
      .input('HoraRevision',          sql.DateTime2,      new Date())
      .input('TieneIncidencia',       sql.Bit,            TieneIncidencia       ? 1 : 0)
      .input('NivelSeveridad',        sql.NVarChar(20),   NivelSeveridad        || null)
      .input('DescripcionIncidencia', sql.NVarChar(4000), DescripcionIncidencia || null)
      .input('RequiereMantenimiento', sql.Bit,            RequiereMantenimiento ? 1 : 0)
      .input('FotoUrl',               sql.NVarChar(500),  FotoUrl               || null)
      .query(`UPDATE RondinesRegistros SET
        Revisado=1, HoraRevision=@HoraRevision,
        TieneIncidencia=@TieneIncidencia, NivelSeveridad=@NivelSeveridad,
        DescripcionIncidencia=@DescripcionIncidencia, RequiereMantenimiento=@RequiereMantenimiento,
        FotoUrl=@FotoUrl
        WHERE RegistroId=@id`);

    // Si requiere mantenimiento, crear OM automáticamente
    let omFolio = null;
    if (RequiereMantenimiento) {
      try {
        const reg = await pool.request().input('id', sql.Int, registroId).query(`
          SELECT rr.*, pr.Nombre AS PuntoNombre, ar.Nombre AS AreaNombre
          FROM RondinesRegistros rr
          LEFT JOIN PuntosRevision pr ON rr.PuntoRevisionId=pr.PuntoRevisionId
          LEFT JOIN AreasRevision  ar ON rr.AreaRevisionId=ar.AreaRevisionId
          WHERE rr.RegistroId=@id
        `);
        const ron = await pool.request().input('id', sql.Int, rondinId)
          .query('SELECT Folio, Guardia FROM Rondines WHERE RondinId=@id');
        if (reg.recordset.length && ron.recordset.length) {
          const registro = reg.recordset[0];
          const rondin   = ron.recordset[0];
          const omR = await pool.request()
            .input('Departamento',     sql.NVarChar(200),    registro.PuntoNombre  || null)
            .input('FechaReporte',     sql.Date,             new Date())
            .input('NombreSolicita',   sql.NVarChar(300),    rondin.Guardia        || null)
            .input('Equipo',           sql.NVarChar(200),    registro.AreaNombre   || null)
            .input('RazonOrden',       sql.NVarChar(100),    'correctivo')
            .input('DescripcionFalla', sql.NVarChar(sql.MAX),
              `Incidencia detectada en rondín ${rondin.Folio}. Área: ${registro.AreaNombre}. ${DescripcionIncidencia || ''}`)
            .input('CreadoPor',        sql.NVarChar(150),    rondin.Guardia        || null)
            .query(`INSERT INTO OrdenesMantenimiento
              (Departamento,FechaReporte,NombreSolicita,Equipo,RazonOrden,DescripcionFalla,CreadoPor,Estado)
              VALUES (@Departamento,@FechaReporte,@NombreSolicita,@Equipo,@RazonOrden,@DescripcionFalla,@CreadoPor,'Pendiente');
              SELECT SCOPE_IDENTITY() AS id;`);
          const omId  = omR.recordset[0].id;
          const year  = new Date().getFullYear();
          omFolio = `OM-${year}-${String(omId).padStart(6, '0')}`;
          await pool.request()
            .input('folio', sql.NVarChar(50), omFolio)
            .input('id',    sql.Int,          omId)
            .query('UPDATE OrdenesMantenimiento SET Folio=@folio WHERE OrdenMantenimientoId=@id');
          await pool.request()
            .input('omId', sql.Int, omId)
            .input('regId', sql.Int, registroId)
            .query('UPDATE RondinesRegistros SET OrdenMantenimientoId=@omId WHERE RegistroId=@regId');
        }
      } catch (e) { console.log('❌ Error creando OM desde rondín:', e.message); }
    }

    res.json({ ok: true, omFolio });

    if (TieneIncidencia) {
      ;(async () => {
        try {
          const ron = await pool.request().input('id', sql.Int, rondinId)
            .query('SELECT Folio, Guardia FROM Rondines WHERE RondinId=@id');
          const reg = await pool.request().input('id', sql.Int, registroId).query(`
            SELECT rr.*, pr.Nombre AS PuntoNombre, ar.Nombre AS AreaNombre
            FROM RondinesRegistros rr
            LEFT JOIN PuntosRevision pr ON rr.PuntoRevisionId=pr.PuntoRevisionId
            LEFT JOIN AreasRevision  ar ON rr.AreaRevisionId=ar.AreaRevisionId
            WHERE rr.RegistroId=@id
          `);
          if (!ron.recordset.length || !reg.recordset.length) return;
          const rondin   = ron.recordset[0];
          const registro = reg.recordset[0];
          const html = emailIncidenciaSeguridad(rondin.Folio, registro.PuntoNombre, registro.AreaNombre,
            NivelSeveridad, DescripcionIncidencia, rondin.Guardia);
          if (NivelSeveridad === 'critica') {
            const admins = await getEmailsPorRoles(['admin']);
            if (admins.length) sendMail(admins, `⚠️ Incidencia CRÍTICA en rondín ${rondin.Folio}`, html);
          }
          if (RequiereMantenimiento) {
            const mant = await getEmailsPorRoles(['mantenimiento', 'jefe_mantenimiento']);
            const asunto = omFolio
              ? `Incidencia en rondín ${rondin.Folio} — OM ${omFolio} generada automáticamente`
              : `Incidencia en rondín ${rondin.Folio} requiere mantenimiento`;
            if (mant.length) sendMail(mant, asunto, html);
          }
        } catch (e) { console.log('Email incidencia rondín:', e.message); }
      })();
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/rondines/:id/finalizar', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const { Observaciones } = req.body;
    await pool.request()
      .input('id',           sql.Int,           id)
      .input('FechaFin',     sql.DateTime2,     new Date())
      .input('Observaciones',sql.NVarChar(4000),Observaciones || null)
      .query(`UPDATE Rondines SET Estado='finalizado',FechaFin=@FechaFin,Observaciones=@Observaciones WHERE RondinId=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Revisiones de Extintores ──────────────────────────────────────────────────

app.get('/api/seguridad/extintores/:id/revisiones', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request()
      .input('id', sql.Int, Number(req.params.id))
      .query('SELECT * FROM RevisionesExtintores WHERE ExtintorId=@id ORDER BY FechaRevision DESC');
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/revisiones-extintores', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d       = req.body;
    const guardia = req.usuario?.nombre || '';
    const r = await pool.request()
      .input('ExtintorId',         sql.Int,           Number(d.ExtintorId))
      .input('Guardia',            sql.NVarChar(200), d.Guardia || guardia)
      .input('FechaRevision',      sql.Date,          d.FechaRevision || new Date().toISOString().substring(0, 10))
      .input('PresionAdecuada',    sql.Bit,           d.PresionAdecuada    ? 1 : 0)
      .input('CondicionFisica',    sql.NVarChar(100), d.CondicionFisica    || null)
      .input('VencimientoVigente', sql.Bit,           d.VencimientoVigente ? 1 : 0)
      .input('Observaciones',      sql.NVarChar(4000),d.Observaciones      || null)
      .query(`INSERT INTO RevisionesExtintores
        (ExtintorId,Guardia,FechaRevision,PresionAdecuada,CondicionFisica,VencimientoVigente,Observaciones)
        VALUES (@ExtintorId,@Guardia,@FechaRevision,@PresionAdecuada,@CondicionFisica,@VencimientoVigente,@Observaciones);
        SELECT SCOPE_IDENTITY() AS id`);
    res.json({ ok: true, id: r.recordset[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Visitas ───────────────────────────────────────────────────────────────────

app.get('/api/seguridad/visitas', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { fecha } = req.query;
    const req2 = pool.request();
    let q = 'SELECT * FROM Visitas';
    if (fecha) { q += ' WHERE CAST(FechaCreacion AS DATE)=@fecha'; req2.input('fecha', sql.Date, fecha); }
    q += ' ORDER BY FechaCreacion DESC';
    const r = await req2.query(q);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/visitas', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d       = req.body;
    const guardia = req.usuario?.nombre || '';
    const r = await pool.request()
      .input('NombreVisitante', sql.NVarChar(300), d.NombreVisitante || '')
      .input('Empresa',         sql.NVarChar(200), d.Empresa         || null)
      .input('Documento',       sql.NVarChar(100), d.Documento       || null)
      .input('TipoVisita',      sql.NVarChar(50),  d.TipoVisita      || 'general')
      .input('AQuienVisita',    sql.NVarChar(300), d.AQuienVisita    || null)
      .input('Motivo',          sql.NVarChar(500), d.Motivo          || null)
      .input('HoraEntrada',     sql.DateTime2,     new Date())
      .input('Guardia',         sql.NVarChar(200), guardia)
      .query(`INSERT INTO Visitas (NombreVisitante,Empresa,Documento,TipoVisita,AQuienVisita,Motivo,HoraEntrada,Guardia)
              VALUES (@NombreVisitante,@Empresa,@Documento,@TipoVisita,@AQuienVisita,@Motivo,@HoraEntrada,@Guardia);
              SELECT SCOPE_IDENTITY() AS id`);
    const visitaId = r.recordset[0].id;
    const folio    = generateSegFolio('VIS', visitaId);
    await pool.request().input('id', sql.Int, visitaId).input('Folio', sql.NVarChar(50), folio)
      .query('UPDATE Visitas SET Folio=@Folio WHERE VisitaId=@id');
    res.json({ ok: true, visitaId, folio });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/visitas/:id/salida', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { Observaciones } = req.body;
    await pool.request()
      .input('id',           sql.Int,           Number(req.params.id))
      .input('HoraSalida',   sql.DateTime2,     new Date())
      .input('Observaciones',sql.NVarChar(4000),Observaciones || null)
      .query('UPDATE Visitas SET HoraSalida=@HoraSalida,Observaciones=@Observaciones WHERE VisitaId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Órdenes de Vehículo ───────────────────────────────────────────────────────

app.get('/api/seguridad/ordenes-vehiculo', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const { estado, mine } = req.query;
    const req2 = pool.request();
    let q = `SELECT ov.*, ISNULL(v.Marca+' '+v.Modelo+' ('+v.Placa+')','Sin vehículo') AS VehiculoNombre
             FROM OrdenesVehiculo ov LEFT JOIN Vehiculos v ON ov.VehiculoId=v.VehiculoId WHERE 1=1`;
    if (estado) { q += ' AND ov.Estado=@estado'; req2.input('estado', sql.NVarChar(50), estado); }
    if (mine)   { q += ' AND ov.Solicitante=@sol'; req2.input('sol', sql.NVarChar(200), req.usuario?.nombre || ''); }
    q += ' ORDER BY ov.FechaCreacion DESC';
    const r = await req2.query(q);
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/seguridad/ordenes-vehiculo', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d          = req.body;
    const solicitante = req.usuario?.nombre || '';
    const r = await pool.request()
      .input('VehiculoId',          sql.Int,           d.VehiculoId ? Number(d.VehiculoId) : null)
      .input('Solicitante',         sql.NVarChar(200), solicitante)
      .input('Destino',             sql.NVarChar(300), d.Destino            || null)
      .input('Motivo',              sql.NVarChar(500), d.Motivo             || null)
      .input('FechaSalidaEstimada', sql.Date,          d.FechaSalidaEstimada|| null)
      .input('HoraSalidaEstimada',  sql.NVarChar(10),  d.HoraSalidaEstimada || null)
      .input('Pasajeros',           sql.Int,           d.Pasajeros ? Number(d.Pasajeros) : null)
      .input('Observaciones',       sql.NVarChar(4000),d.Observaciones      || null)
      .query(`INSERT INTO OrdenesVehiculo
        (VehiculoId,Solicitante,Destino,Motivo,FechaSalidaEstimada,HoraSalidaEstimada,Pasajeros,Observaciones)
        VALUES (@VehiculoId,@Solicitante,@Destino,@Motivo,@FechaSalidaEstimada,@HoraSalidaEstimada,@Pasajeros,@Observaciones);
        SELECT SCOPE_IDENTITY() AS id`);
    const ordenId = r.recordset[0].id;
    const folio   = generateSegFolio('SV', ordenId);
    await pool.request().input('id', sql.Int, ordenId).input('Folio', sql.NVarChar(50), folio)
      .query('UPDATE OrdenesVehiculo SET Folio=@Folio WHERE OrdenVehiculoId=@id');
    res.json({ ok: true, ordenId, folio });

    ;(async () => {
      try {
        let vehiculoNombre = '-';
        if (d.VehiculoId) {
          const vr = await pool.request().input('vid', sql.Int, Number(d.VehiculoId))
            .query("SELECT Marca+' '+Modelo+' ('+Placa+')' AS N FROM Vehiculos WHERE VehiculoId=@vid");
          if (vr.recordset.length) vehiculoNombre = vr.recordset[0].N;
        }
        const encargados = await getEmailsPorRoles(['encargado_vehiculos']);
        console.log(`📧 Solicitud vehículo ${folio}: ${encargados.length} destinatarios → ${JSON.stringify(encargados)}`);
        if (encargados.length)
          sendMail(encargados, `Nueva Solicitud de Vehículo — ${folio}`,
            emailSolicitudVehiculo(folio, vehiculoNombre, d.Destino, d.Motivo, d.FechaSalidaEstimada, d.HoraSalidaEstimada, solicitante));
      } catch (e) { console.log('Email solicitud vehículo:', e.message); }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/ordenes-vehiculo/:id/autorizar', autenticar, soloEncargadoVehiculos, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    await pool.request()
      .input('id',               sql.Int,           id)
      .input('AutorizadoPor',    sql.NVarChar(200), req.usuario?.nombre || '')
      .input('FechaAutorizacion',sql.DateTime2,     new Date())
      .query(`UPDATE OrdenesVehiculo SET Estado='autorizada',AutorizadoPor=@AutorizadoPor,FechaAutorizacion=@FechaAutorizacion WHERE OrdenVehiculoId=@id`);
    res.json({ ok: true });

    ;(async () => {
      try {
        const r = await pool.request().input('id', sql.Int, id).query(`
          SELECT ov.Folio, ov.Destino, ov.Solicitante,
            ISNULL(v.Marca+' '+v.Modelo+' ('+v.Placa+')','Sin vehículo') AS VehiculoNombre
          FROM OrdenesVehiculo ov LEFT JOIN Vehiculos v ON ov.VehiculoId=v.VehiculoId
          WHERE ov.OrdenVehiculoId=@id
        `);
        const orden = r.recordset[0];
        if (!orden) return;
        const emails = await getEmailDeUsuario(orden.Solicitante);
        if (emails.length) sendMail(emails, `Solicitud ${orden.Folio} autorizada`,
          emailVehiculoResuelto(orden.Folio, orden.VehiculoNombre, orden.Destino, 'autorizada', null));
      } catch (e) { console.log('Email autorización vehículo:', e.message); }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/ordenes-vehiculo/:id/rechazar', autenticar, soloEncargadoVehiculos, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const { MotivoRechazo } = req.body;
    await pool.request()
      .input('id',            sql.Int,           id)
      .input('AutorizadoPor', sql.NVarChar(200), req.usuario?.nombre || '')
      .input('MotivoRechazo', sql.NVarChar(500), MotivoRechazo || null)
      .query(`UPDATE OrdenesVehiculo SET Estado='rechazada',AutorizadoPor=@AutorizadoPor,MotivoRechazo=@MotivoRechazo WHERE OrdenVehiculoId=@id`);
    res.json({ ok: true });

    ;(async () => {
      try {
        const r = await pool.request().input('id', sql.Int, id).query(`
          SELECT ov.Folio, ov.Destino, ov.Solicitante,
            ISNULL(v.Marca+' '+v.Modelo+' ('+v.Placa+')','Sin vehículo') AS VehiculoNombre
          FROM OrdenesVehiculo ov LEFT JOIN Vehiculos v ON ov.VehiculoId=v.VehiculoId
          WHERE ov.OrdenVehiculoId=@id
        `);
        const orden = r.recordset[0];
        if (!orden) return;
        const emails = await getEmailDeUsuario(orden.Solicitante);
        if (emails.length) sendMail(emails, `Solicitud ${orden.Folio} rechazada`,
          emailVehiculoResuelto(orden.Folio, orden.VehiculoNombre, orden.Destino, 'rechazada', MotivoRechazo));
      } catch (e) { console.log('Email rechazo vehículo:', e.message); }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/ordenes-vehiculo/:id/salida', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const { KmInicial, FotoSalidaFrontal, FotoSalidaTrasero, FotoSalidaLateralIzq, FotoSalidaLateralDer } = req.body;
    await pool.request()
      .input('id',                   sql.Int,           id)
      .input('HoraSalidaReal',       sql.DateTime2,     new Date())
      .input('KmInicial',            sql.Decimal(10,2), KmInicial ? Number(KmInicial) : null)
      .input('RegistradoPorSalida',  sql.NVarChar(200), req.usuario?.nombre || '')
      .input('FotoSalidaFrontal',    sql.NVarChar(500), FotoSalidaFrontal    || null)
      .input('FotoSalidaTrasero',    sql.NVarChar(500), FotoSalidaTrasero    || null)
      .input('FotoSalidaLateralIzq', sql.NVarChar(500), FotoSalidaLateralIzq || null)
      .input('FotoSalidaLateralDer', sql.NVarChar(500), FotoSalidaLateralDer || null)
      .query(`UPDATE OrdenesVehiculo SET
        Estado='en_curso', HoraSalidaReal=@HoraSalidaReal, KmInicial=@KmInicial, RegistradoPorSalida=@RegistradoPorSalida,
        FotoSalidaFrontal=@FotoSalidaFrontal, FotoSalidaTrasero=@FotoSalidaTrasero,
        FotoSalidaLateralIzq=@FotoSalidaLateralIzq, FotoSalidaLateralDer=@FotoSalidaLateralDer
        WHERE OrdenVehiculoId=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/seguridad/ordenes-vehiculo/:id/llegada', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    const { KmFinal, Observaciones, FotoLlegadaFrontal, FotoLlegadaTrasero, FotoLlegadaLateralIzq, FotoLlegadaLateralDer } = req.body;
    await pool.request()
      .input('id',                    sql.Int,           id)
      .input('HoraLlegada',           sql.DateTime2,     new Date())
      .input('KmFinal',               sql.Decimal(10,2), KmFinal ? Number(KmFinal) : null)
      .input('Observaciones',         sql.NVarChar(4000),Observaciones || null)
      .input('RegistradoPorLlegada',  sql.NVarChar(200), req.usuario?.nombre || '')
      .input('FotoLlegadaFrontal',    sql.NVarChar(500), FotoLlegadaFrontal    || null)
      .input('FotoLlegadaTrasero',    sql.NVarChar(500), FotoLlegadaTrasero    || null)
      .input('FotoLlegadaLateralIzq', sql.NVarChar(500), FotoLlegadaLateralIzq || null)
      .input('FotoLlegadaLateralDer', sql.NVarChar(500), FotoLlegadaLateralDer || null)
      .query(`UPDATE OrdenesVehiculo SET
        Estado='completada', HoraLlegada=@HoraLlegada, KmFinal=@KmFinal, Observaciones=@Observaciones, RegistradoPorLlegada=@RegistradoPorLlegada,
        FotoLlegadaFrontal=@FotoLlegadaFrontal, FotoLlegadaTrasero=@FotoLlegadaTrasero,
        FotoLlegadaLateralIzq=@FotoLlegadaLateralIzq, FotoLlegadaLateralDer=@FotoLlegadaLateralDer
        WHERE OrdenVehiculoId=@id`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE endpoints Seguridad ────────────────────────────────────────────────

app.delete('/api/seguridad/vehiculos/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    await pool.request()
      .input('id', sql.Int, Number(req.params.id))
      .query('UPDATE Vehiculos SET Activo=0 WHERE VehiculoId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/seguridad/extintores/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    await pool.request()
      .input('id', sql.Int, Number(req.params.id))
      .query('UPDATE Extintores SET Activo=0 WHERE ExtintorId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/seguridad/visitas/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    await pool.request()
      .input('id', sql.Int, Number(req.params.id))
      .query('DELETE FROM Visitas WHERE VisitaId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/seguridad/rondines/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const id = Number(req.params.id);
    await pool.request().input('id', sql.Int, id).query('DELETE FROM RondinesRegistros WHERE RondinId=@id');
    await pool.request().input('id', sql.Int, id).query('DELETE FROM Rondines WHERE RondinId=@id');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/seguridad/ordenes-vehiculo/:id', autenticar, soloAdminOJefeSeg, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    await pool.request()
      .input('id', sql.Int, Number(req.params.id))
      .query("DELETE FROM OrdenesVehiculo WHERE OrdenVehiculoId=@id AND Estado IN ('pendiente','rechazada')");
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Dashboard de Seguridad ────────────────────────────────────────────────────

app.get('/api/seguridad/dashboard', autenticar, async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const hoy = new Date().toISOString().substring(0, 10);
    const [rondines, visitas, vehiculos, incidencias] = await Promise.all([
      pool.request().input('hoy', sql.Date, hoy).query(
        `SELECT COUNT(*) AS hoy, SUM(CASE WHEN Estado='en_curso' THEN 1 ELSE 0 END) AS activos
         FROM Rondines WHERE CAST(FechaCreacion AS DATE)=@hoy`),
      pool.request().input('hoy', sql.Date, hoy).query(
        `SELECT COUNT(*) AS hoy, SUM(CASE WHEN HoraSalida IS NULL THEN 1 ELSE 0 END) AS activos
         FROM Visitas WHERE CAST(FechaCreacion AS DATE)=@hoy`),
      pool.request().query(`SELECT Estado, COUNT(*) AS total FROM OrdenesVehiculo GROUP BY Estado`),
      pool.request().query(`SELECT COUNT(*) AS total FROM RondinesRegistros WHERE TieneIncidencia=1`),
    ]);
    const estadosV = {};
    vehiculos.recordset.forEach(r => { estadosV[r.Estado] = r.total; });
    res.json({
      rondinesHoy:        rondines.recordset[0].hoy     || 0,
      rondinesActivos:    rondines.recordset[0].activos  || 0,
      visitasHoy:         visitas.recordset[0].hoy       || 0,
      visitasAdentro:     visitas.recordset[0].activos   || 0,
      vehiculosPendientes:estadosV.pendiente  || 0,
      vehiculosEnCurso:   estadosV.en_curso   || 0,
      totalIncidencias:   incidencias.recordset[0].total || 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── UPLOAD FOTOS (Cloudinary) ───────────────────────────────────────────────
app.post('/api/upload/foto-vehiculo', autenticar, async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: 'No se recibió imagen' });
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'vehiculos',
      resource_type: 'image',
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.log('❌ Error Cloudinary vehiculo:', err.message);
    res.status(500).json({ error: err.message || 'No se pudo subir la imagen' });
  }
});

app.post('/api/upload/foto-rondin', autenticar, async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!base64) return res.status(400).json({ error: 'No se recibió imagen' });
    const result = await cloudinary.uploader.upload(base64, {
      folder: 'rondines',
      resource_type: 'image',
    });
    console.log(`✅ Foto subida a Cloudinary: ${result.secure_url}`);
    res.json({ url: result.secure_url });
  } catch (err) {
    console.log('❌ Error Cloudinary:', err.http_code, err.message, JSON.stringify(err));
    res.status(500).json({ error: err.message || 'No se pudo subir la imagen' });
  }
});

// ── Endpoints públicos (sin autenticación) ────────────────────────────────────

app.get('/api/public/vehiculos', async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const r = await pool.request()
      .query('SELECT VehiculoId, Marca, Modelo, Placa, Color, Capacidad FROM Vehiculos WHERE Activo=1 ORDER BY Marca, Modelo');
    res.json(r.recordset);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/public/solicitud-vehiculo', async (req, res) => {
  try {
    if (!ensurePool(res)) return;
    const d = req.body;
    if (!d.Solicitante || !d.Destino || !d.FechaSalidaEstimada)
      return res.status(400).json({ error: 'Faltan campos obligatorios: Solicitante, Destino, FechaSalidaEstimada' });
    const r = await pool.request()
      .input('VehiculoId',          sql.Int,            d.VehiculoId ? Number(d.VehiculoId) : null)
      .input('Solicitante',         sql.NVarChar(200),  d.Solicitante)
      .input('Destino',             sql.NVarChar(300),  d.Destino            || null)
      .input('Motivo',              sql.NVarChar(500),  d.Motivo             || null)
      .input('FechaSalidaEstimada', sql.Date,           d.FechaSalidaEstimada|| null)
      .input('HoraSalidaEstimada',  sql.NVarChar(10),   d.HoraSalidaEstimada || null)
      .input('Pasajeros',           sql.Int,            d.Pasajeros ? Number(d.Pasajeros) : null)
      .input('Observaciones',       sql.NVarChar(4000), d.Observaciones      || null)
      .query(`INSERT INTO OrdenesVehiculo
        (VehiculoId,Solicitante,Destino,Motivo,FechaSalidaEstimada,HoraSalidaEstimada,Pasajeros,Observaciones)
        VALUES (@VehiculoId,@Solicitante,@Destino,@Motivo,@FechaSalidaEstimada,@HoraSalidaEstimada,@Pasajeros,@Observaciones);
        SELECT SCOPE_IDENTITY() AS id`);
    const ordenId = r.recordset[0].id;
    const folio   = generateSegFolio('SV', ordenId);
    await pool.request().input('id', sql.Int, ordenId).input('Folio', sql.NVarChar(50), folio)
      .query('UPDATE OrdenesVehiculo SET Folio=@Folio WHERE OrdenVehiculoId=@id');
    res.json({ ok: true, ordenId, folio });
    ;(async () => {
      try {
        let vehiculoNombre = 'No especificado';
        if (d.VehiculoId) {
          const vr = await pool.request().input('vid', sql.Int, Number(d.VehiculoId))
            .query("SELECT Marca+' '+Modelo+' ('+Placa+')' AS N FROM Vehiculos WHERE VehiculoId=@vid");
          if (vr.recordset.length) vehiculoNombre = vr.recordset[0].N;
        }
        const encargados = await getEmailsPorRoles(['encargado_vehiculos']);
        console.log(`📧 Solicitud vehículo (pública) ${folio}: ${encargados.length} destinatarios → ${JSON.stringify(encargados)}`);
        if (encargados.length)
          sendMail(encargados, `Nueva Solicitud de Vehículo — ${folio}`,
            emailSolicitudVehiculo(folio, vehiculoNombre, d.Destino, d.Motivo, d.FechaSalidaEstimada, d.HoraSalidaEstimada, d.Solicitante));
      } catch (e) { console.log('Email solicitud vehículo pública:', e.message); }
    })();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Diagnóstico email ─────────────────────────────────────────────────────────
app.get('/api/debug/test-email', async (req, res) => {
  if (!GMAIL_USER || !GMAIL_APP_PASS) return res.json({ ok: false, error: 'GMAIL_USER/GMAIL_APP_PASS no configurado' });
  const dest = req.query.to || "brandon.rodriguez@udat.com.mx";
  try {
    await mailTransporter.sendMail({ from: `"Sistema UDAT" <${GMAIL_USER}>`, to: dest, subject: 'Test Gmail — Sistema UDAT', html: '<p>Correo de prueba via Gmail SMTP.</p>' });
    res.json({ ok: true, message: `Email enviado a ${dest}` });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── SERVER ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));
