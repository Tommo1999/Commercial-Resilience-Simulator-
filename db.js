const { MongoClient } = require("mongodb");

const client = new MongoClient(process.env.MONGODB_URI);

let db;

async function connectDB() {
    if (db) {
        return db;
    }

    await client.connect();

    db = client.db("off-book");

    console.log("MongoDB connected");

    return db;
}

module.exports = {
    connectDB
};