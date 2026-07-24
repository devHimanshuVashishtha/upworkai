const { MongoClient } = require('mongodb');
const config = require('./config');

let client = null;
let db = null;

async function connectDb() {
  if (db) return db;

  try {
    console.log(`🔌 Connecting to MongoDB: ${config.MONGODB_URI}`);
    client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    db = client.db(config.MONGODB_DB_NAME);
    console.log(`✅ Connected successfully to MongoDB database: ${config.MONGODB_DB_NAME}`);
    return db;
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err.message);
    throw err;
  }
}

async function saveJobAlert(job, queryName, proposal = '', summary = '') {
  try {
    const database = await connectDb();
    const collection = database.collection('alerts');

    // Extract unique ID from the link to ensure we have a fallback
    let jobId = job.link ? job.link.match(/~[0-9a-fA-F]+/) : null;
    jobId = jobId ? jobId[0] : job.link;

    const document = {
      jobId,
      title: job.title,
      link: job.link,
      description: job.description,
      connects: job.connects || null,
      score: job.score || null,
      queryName,
      proposal,
      summary,
      status: 'pending',
      notifiedAt: new Date(),
    };

    // Upsert based on unique jobId to prevent duplicate rows in the DB
    await collection.updateOne(
      { jobId },
      { $set: document },
      { upsert: true }
    );
    console.log(`💾 Job saved/updated in MongoDB collection: [ID: ${jobId}] "${job.title}"`);
  } catch (err) {
    console.error('❌ Error saving job alert to MongoDB:', err.message);
  }
}

async function updateJobStatus(jobId, status) {
  try {
    const database = await connectDb();
    const collection = database.collection('alerts');
    await collection.updateOne(
      { jobId },
      { $set: { status, updatedAt: new Date() } }
    );
    console.log(`💾 Job status updated to "${status}" in MongoDB: [ID: ${jobId}]`);
  } catch (err) {
    console.error(`❌ Error updating status for Job [${jobId}]:`, err.message);
  }
}

async function getJobAlert(jobId) {
  try {
    const database = await connectDb();
    const collection = database.collection('alerts');
    return await collection.findOne({ jobId });
  } catch (err) {
    console.error(`❌ Error fetching Job [${jobId}] from MongoDB:`, err.message);
    return null;
  }
}

async function getAnalyticsSummary() {
  try {
    const database = await connectDb();
    const collection = database.collection('alerts');

    const totalAlerts = await collection.countDocuments({});
    const approvedCount = await collection.countDocuments({ status: { $in: ['approved', 'submitted'] } });
    const rejectedCount = await collection.countDocuments({ status: 'rejected' });
    const pendingCount = await collection.countDocuments({ status: 'pending' });

    const queryBreakdown = await collection.aggregate([
      { $group: { _id: '$queryName', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]).toArray();

    const conversionRate = totalAlerts > 0 ? ((approvedCount / totalAlerts) * 100).toFixed(1) : '0.0';

    return {
      totalAlerts,
      approvedCount,
      rejectedCount,
      pendingCount,
      conversionRate,
      queryBreakdown
    };
  } catch (err) {
    console.error('❌ Error generating analytics summary:', err.message);
    return null;
  }
}

async function saveAccount(account) {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    
    const document = {
      email: account.email,
      password: account.password,
      name: account.name,
      rules: account.rules || {},
      isActive: account.isActive === true,
      updatedAt: new Date()
    };
    
    await collection.updateOne(
      { email: account.email },
      { $set: document },
      { upsert: true }
    );
    console.log(`💾 Saved/updated account in MongoDB: ${account.email}`);
    return true;
  } catch (err) {
    console.error('❌ Error saving account to MongoDB:', err.message);
    return false;
  }
}

async function getAccounts() {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    return await collection.find({}).toArray();
  } catch (err) {
    console.error('❌ Error getting accounts from MongoDB:', err.message);
    return [];
  }
}

async function getActiveAccount() {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    return await collection.findOne({ isActive: true });
  } catch (err) {
    console.error('❌ Error getting active account from MongoDB:', err.message);
    return null;
  }
}

async function setActiveAccount(email) {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    
    await collection.updateMany({}, { $set: { isActive: false } });
    const res = await collection.updateOne({ email }, { $set: { isActive: true } });
    console.log(`💾 Active account switched to: ${email}`);
    return res.modifiedCount > 0 || res.matchedCount > 0;
  } catch (err) {
    console.error('❌ Error setting active account in MongoDB:', err.message);
    return false;
  }
}

async function deleteAccount(email) {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    const res = await collection.deleteOne({ email });
    console.log(`🗑️ Deleted account from MongoDB: ${email}`);
    return res.deletedCount > 0;
  } catch (err) {
    console.error('❌ Error deleting account from MongoDB:', err.message);
    return false;
  }
}

async function updateAccountRules(email, rules) {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    await collection.updateOne({ email }, { $set: { rules, updatedAt: new Date() } });
    console.log(`💾 Rules updated in MongoDB for account: ${email}`);
    return true;
  } catch (err) {
    console.error(`❌ Error updating rules for account [${email}]:`, err.message);
    return false;
  }
}

async function getAuthorizedUsers() {
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    const users = await collection.find({ status: { $ne: 'revoked' } }).toArray();
    const list = users.map(u => u.chatId.toString());
    if (!list.includes(config.CHAT_ID.toString())) {
      list.push(config.CHAT_ID.toString());
    }
    return list;
  } catch (err) {
    console.error('❌ Error getting authorized users from MongoDB:', err.message);
    return [config.CHAT_ID.toString()];
  }
}

async function addAuthorizedUser(chatId, username) {
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    await collection.updateOne(
      { chatId: chatId.toString() },
      {
        $set: {
          chatId: chatId.toString(),
          username,
          status: 'authorized',
          approvedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`💾 Authorized user added to MongoDB: ${username} (${chatId})`);
    return true;
  } catch (err) {
    console.error('❌ Error adding authorized user to MongoDB:', err.message);
    return false;
  }
}

async function isUserAuthorized(chatId) {
  if (chatId.toString() === config.CHAT_ID.toString()) return true;
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    const user = await collection.findOne({ chatId: chatId.toString() });
    return user && user.status !== 'revoked';
  } catch (err) {
    console.error('❌ Error checking user authorization in MongoDB:', err.message);
    return false;
  }
}

async function getPendingAccessRequest(chatId) {
  try {
    const database = await connectDb();
    const collection = database.collection('pending_access_requests');
    return await collection.findOne({ chatId: chatId.toString() });
  } catch (err) {
    console.error('❌ Error getting pending access request from MongoDB:', err.message);
    return null;
  }
}

async function createPendingAccessRequest(chatId, username) {
  try {
    const database = await connectDb();
    const collection = database.collection('pending_access_requests');
    await collection.updateOne(
      { chatId: chatId.toString() },
      { $set: { chatId: chatId.toString(), username, requestedAt: new Date() } },
      { upsert: true }
    );
    console.log(`💾 Created pending access request in MongoDB: ${username} (${chatId})`);
    return true;
  } catch (err) {
    console.error('❌ Error creating pending access request in MongoDB:', err.message);
    return false;
  }
}

async function deletePendingAccessRequest(chatId) {
  try {
    const database = await connectDb();
    const collection = database.collection('pending_access_requests');
    await collection.deleteOne({ chatId: chatId.toString() });
    return true;
  } catch (err) {
    console.error('❌ Error deleting pending access request from MongoDB:', err.message);
    return false;
  }
}

async function getAuthorizedUsersDetailed() {
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    return await collection.find({ status: { $ne: 'revoked' } }).toArray();
  } catch (err) {
    console.error('❌ Error getting detailed authorized users from MongoDB:', err.message);
    return [];
  }
}

async function getRevokedUsersDetailed() {
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    return await collection.find({ status: { $in: ['revoked', 'denied'] } }).toArray();
  } catch (err) {
    console.error('❌ Error getting detailed revoked users from MongoDB:', err.message);
    return [];
  }
}

async function denyAuthorizedUser(chatId, username) {
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    await collection.updateOne(
      { chatId: chatId.toString() },
      {
        $set: {
          chatId: chatId.toString(),
          username,
          status: 'denied',
          deniedAt: new Date()
        }
      },
      { upsert: true }
    );
    console.log(`❌ Set status to denied for user in MongoDB: ${chatId}`);
    return true;
  } catch (err) {
    console.error('❌ Error setting user status to denied in MongoDB:', err.message);
    return false;
  }
}

async function removeAuthorizedUser(chatId) {
  try {
    const database = await connectDb();
    const collection = database.collection('authorized_users');
    const res = await collection.updateOne(
      { chatId: chatId.toString() },
      {
        $set: {
          status: 'revoked',
          revokedAt: new Date()
        }
      }
    );
    console.log(`🗑️ Set status to revoked for user in MongoDB: ${chatId}`);
    return res.modifiedCount > 0;
  } catch (err) {
    console.error('❌ Error removing authorized user from MongoDB:', err.message);
    return false;
  }
}

async function saveCookiesToDb(email, cookies) {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    await collection.updateOne(
      { email: email.toLowerCase() },
      {
        $set: {
          cookies,
          cookiesUpdatedAt: new Date()
        }
      }
    );
    console.log(`💾 Sync: Session cookies saved to MongoDB collection for ${email}`);
    return true;
  } catch (err) {
    console.error('❌ Error saving cookies to MongoDB:', err.message);
    return false;
  }
}

async function loadCookiesFromDb(email) {
  try {
    const database = await connectDb();
    const collection = database.collection('accounts');
    const acc = await collection.findOne({ email: email.toLowerCase() });
    if (acc && acc.cookies) {
      console.log(`🔌 Sync: Loaded cookies from MongoDB collection for ${email}`);
      return acc.cookies;
    }
    return null;
  } catch (err) {
    console.error('❌ Error loading cookies from MongoDB:', err.message);
    return null;
  }
}

module.exports = {
  connectDb,
  saveJobAlert,
  updateJobStatus,
  getJobAlert,
  getAnalyticsSummary,
  saveAccount,
  getAccounts,
  getActiveAccount,
  setActiveAccount,
  deleteAccount,
  updateAccountRules,
  getAuthorizedUsers,
  addAuthorizedUser,
  isUserAuthorized,
  getPendingAccessRequest,
  createPendingAccessRequest,
  deletePendingAccessRequest,
  getAuthorizedUsersDetailed,
  getRevokedUsersDetailed,
  denyAuthorizedUser,
  removeAuthorizedUser,
  saveCookiesToDb,
  loadCookiesFromDb,
};
