const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGODB_URI);

let db;

async function connectDB() {
    if (db) {
        return db;
    }

    await client.connect();

    db = client.db("commercial-resilience-simulator");

  console.log(
    "MongoDB connected to database:",
    db.databaseName
);

    return db;
}

module.exports = {
    connectDB
};