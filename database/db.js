const sql = require('mssql');
require('dotenv').config();

const config = {
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT),

    database: process.env.DB_NAME,

    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,

    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

const connectDB = async () => {

    try {

        await sql.connect(config);

        console.log('SQL Server conectado');

    } catch (error) {

        console.log(error);

    }

};

module.exports = {
    sql,
    connectDB
};