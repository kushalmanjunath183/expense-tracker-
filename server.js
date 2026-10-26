require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { z } = require('zod');
const path = require('node:path');
const db = require('./src/config/database');

const Store = session.Store;
class SQLiteSessionStore extends Store {
  constructor() {
    super();
    this.getStatement = db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?');
    this.setStatement = db.prepare('INSERT INTO sessions(sid,sess,expired) VALUES(?,?,?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess,expired=excluded.expired');
    this.deleteStatement = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.cleanupStatement = db.prepare('DELETE FROM sessions WHERE expired <= ?');
    setInterval(() => this.cleanupStatement.run(Date.now()), 60 * 60 * 1000).unref();
  }
  get(sid, callback) {
    try {
      const row = this.getStatement.get(sid);
      if (!row) return callback(null, null);
      if (row.expired <= Date.now()) { this.deleteStatement.run(sid); return callback(null, null); }
      callback(null, JSON.parse(row.sess));
    } catch (error) { callback(error); }
  }
  set(sid, value, callback = () => {}) {
    try { const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 7 * 86400000; this.setStatement.run(sid, JSON.stringify(value), expires); callback(null); }
    catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) { try { this.deleteStatement.run(sid); callback(null); } catch (error) { callback(error); } }
  touch(sid, value, callback = () => {}) { this.set(sid, value, callback); }
}
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is required in production.');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const categories = {
  expense: ['Food and dining','Transport','Shopping','Bills and utilities','Entertainment','Healthcare','Education','Travel','Rent','Groceries','Personal care','Other'],
  income: ['Salary','Freelancing','Business','Investments','Gifts','Other income']
};
const methods = ['Cash','UPI','Debit card','Credit card','Bank transfer','Other'];
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (value) => datePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const amountSchema = z.number().positive().finite().max(1000000000);
const transactionSchema = z.object({
  title: z.string().trim().min(1).max(100), amount: amountSchema,
  type: z.enum(['income','expense']), category: z.string().min(1).max(60),
  paymentMethod: z.enum(methods), date: z.string().regex(datePattern), notes: z.string().max(500).optional().default('')
});
const money = (amount) => Math.round(amount * 100);
const publicTransaction = (row) => ({ ...row, amount: row.amount_cents / 100, paymentMethod: row.payment_method, recurringId: row.recurring_id, occurrenceDate: row.occurrence_date, createdAt: row.created_at });
const publicBudget = (row) => ({ id: row.id, category: row.category, amount: row.amount_cents / 100, spent: row.spent / 100, remaining: (row.amount_cents - row.spent) / 100, percent: row.amount_cents ? Math.round(row.spent * 1000 / row.amount_cents) / 10 : 0, month: row.month });

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], fontSrc: ["'self'", 'https://fonts.gstatic.com'], connectSrc: ["'self'"], imgSrc: ["'self'", 'data:'] } }
}));
app.use(express.json({ limit: '32kb' }));
app.use(session({
  store: new SQLiteSessionStore(),
  name: 'pocketwise.sid', secret: process.env.SESSION_SECRET || 'local-development-secret-change-before-deploy',
  resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000 }
}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
const auth = (req, res, next) => req.session.userId ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req,res,next)).catch(next);
const validate = (schema, data) => {
  const parsed = schema.safeParse(data);
  return parsed.success ? { value: parsed.data } : { error: parsed.error.issues.map((i) => i.message).join(' ') };
};
const addMonth = (date) => { const next = new Date(`${date}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth()+1); return next.toISOString().slice(0,10); };
function generateRecurring(userId) {
  const today = new Date().toISOString().slice(0,10);
  const rows = db.prepare('SELECT * FROM recurring_transactions WHERE user_id = ? AND active = 1').all(userId);
  const insert = db.prepare(`INSERT OR IGNORE INTO transactions(user_id,title,amount_cents,type,category,payment_method,date,recurring_id,occurrence_date) VALUES(?,?,?,?,?,?,?,?,?)`);
  const update = db.prepare('UPDATE recurring_transactions SET last_generated_date = ? WHERE id = ? AND user_id = ?');
  const tx = db.transaction(() => {
    for (const row of rows) {
      let due = row.last_generated_date ? advance(row.last_generated_date, row.frequency, row.start_date) : row.start_date;
      let safety = 0;
      while (due <= today && (!row.end_date || due <= row.end_date) && safety++ < 1000) {
        insert.run(userId,row.title,row.amount_cents,row.type,row.category,row.payment_method,due,row.id,due);
        update.run(due,row.id,userId);
        due = advance(due, row.frequency, row.start_date);
      }
      if (row.start_date <= today && !row.last_generated_date && safety === 0 && (!row.end_date || row.start_date <= row.end_date)) {
        insert.run(userId,row.title,row.amount_cents,row.type,row.category,row.payment_method,row.start_date,row.id,row.start_date);
        update.run(row.start_date,row.id,userId);
      }
    }
  });
  tx();
}
function advance(iso, frequency, anchorDate) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate()+1);
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate()+7);
  if (frequency === 'monthly' || frequency === 'yearly') {
    const anchorDay = Number(anchorDate.slice(-2));
    const year = d.getUTCFullYear() + (frequency === 'yearly' ? 1 : 0);
    const month = d.getUTCMonth() + (frequency === 'monthly' ? 1 : 0);
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    d.setUTCFullYear(year, month, Math.min(anchorDay, lastDay));
  }
  return d.toISOString().slice(0,10);
}
function validateTransaction(body) {
  const parsed = validate(transactionSchema, body);
  if (!parsed.error && !validDate(parsed.value.date)) parsed.error = 'Enter a real calendar date.';
  if (!parsed.error && !categories[parsed.value.type].includes(parsed.value.category)) parsed.error = 'Choose a valid category for this transaction type.';
  return parsed;
}
app.get('/api/health', (_req,res) => res.json({ ok: true }));
app.post('/api/auth/register', asyncRoute(async (req,res) => {
  const parsed = validate(z.object({ name:z.string().trim().min(1).max(80), email:z.string().trim().email().max(200), password:z.string().min(10).max(100) }), req.body);
  if(parsed.error) return res.status(400).json({error:parsed.error});
  const {name,email,password}=parsed.value;
  try {
    const result=db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name,email,bcrypt.hashSync(password,12));
    req.session.userId=Number(result.lastInsertRowid); req.session.userName=name;
    res.status(201).json({user:{id:req.session.userId,name,email:email.toLowerCase()}});
  } catch(error) { if(error.code==='SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({error:'An account with this email already exists.'}); throw error; }
}));
app.post('/api/auth/login', asyncRoute(async(req,res)=>{
  const parsed=validate(z.object({email:z.string().trim().email(),password:z.string().min(1).max(100)}),req.body);
  if(parsed.error) return res.status(400).json({error:parsed.error});
  const user=db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(parsed.value.email);
  if(!user || !bcrypt.compareSync(parsed.value.password,user.password_hash)) return res.status(401).json({error:'Email or password is incorrect.'});
  req.session.regenerate((error)=>{ if(error) return res.status(500).json({error:'Unable to start session.'}); req.session.userId=user.id; req.session.userName=user.name; res.json({user:{id:user.id,name:user.name,email:user.email}}); });
}));
app.post('/api/auth/logout',(req,res)=>req.session.destroy((error)=>{if(error)return res.status(500).json({error:'Could not sign out.'});res.clearCookie('pocketwise.sid');res.status(204).end();}));
app.get('/api/auth/me',auth,(req,res)=>{const user=db.prepare('SELECT id,name,email FROM users WHERE id=?').get(req.session.userId);res.json({user});});
app.get('/api/meta',(req,res)=>res.json({categories,methods}));
app.get('/api/transactions',auth,(req,res)=>{
  generateRecurring(req.session.userId);
  const conditions=['user_id=?'], values=[req.session.userId];
  if(req.query.type && !['income','expense'].includes(req.query.type)) return res.status(400).json({error:'Type must be income or expense.'});
  for(const [key,column] of [['type','type'],['category','category'],['from','date'],['to','date']]) if(req.query[key]) { if((key==='from'||key==='to')&&!validDate(req.query[key])) return res.status(400).json({error:'Dates must be real calendar dates in YYYY-MM-DD format.'}); conditions.push(`${column}${key==='from'?'>=':key==='to'?'<=':'='}?`); values.push(req.query[key]); }
  if(req.query.search){conditions.push('title LIKE ?');values.push(`%${String(req.query.search).slice(0,100)}%`);}
  const sort=req.query.sort==='amount'?'amount_cents':'date'; const direction=req.query.order==='asc'?'ASC':'DESC';
  const rows=db.prepare(`SELECT * FROM transactions WHERE ${conditions.join(' AND ')} ORDER BY ${sort} ${direction}, id DESC LIMIT 1000`).all(...values);
  res.json({transactions:rows.map(publicTransaction)});
});
app.post('/api/transactions',auth,(req,res)=>{
  const parsed=validateTransaction(req.body);if(parsed.error)return res.status(400).json({error:parsed.error});
  const t=parsed.value;const result=db.prepare('INSERT INTO transactions(user_id,title,amount_cents,type,category,payment_method,date,notes) VALUES(?,?,?,?,?,?,?,?)').run(req.session.userId,t.title,money(t.amount),t.type,t.category,t.paymentMethod,t.date,t.notes);
  res.status(201).json({transaction:publicTransaction(db.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').get(result.lastInsertRowid,req.session.userId))});
});
app.put('/api/transactions/:id',auth,(req,res)=>{
  const parsed=validateTransaction(req.body);if(parsed.error)return res.status(400).json({error:parsed.error});const t=parsed.value;
  const result=db.prepare('UPDATE transactions SET title=?,amount_cents=?,type=?,category=?,payment_method=?,date=?,notes=? WHERE id=? AND user_id=? AND recurring_id IS NULL').run(t.title,money(t.amount),t.type,t.category,t.paymentMethod,t.date,t.notes,Number(req.params.id),req.session.userId);
  if(!result.changes)return res.status(404).json({error:'Transaction not found or managed by a recurring rule.'});res.json({transaction:publicTransaction(db.prepare('SELECT * FROM transactions WHERE id=?').get(Number(req.params.id)))});
});
app.delete('/api/transactions/:id',auth,(req,res)=>{const result=db.prepare('DELETE FROM transactions WHERE id=? AND user_id=? AND recurring_id IS NULL').run(Number(req.params.id),req.session.userId);if(!result.changes)return res.status(404).json({error:'Transaction not found or managed by a recurring rule.'});res.status(204).end();});
app.get('/api/budgets',auth,(req,res)=>{
  const month=req.query.month||new Date().toISOString().slice(0,7);if(!monthPattern.test(month))return res.status(400).json({error:'Month must use YYYY-MM.'});
  const rows=db.prepare(`SELECT b.*, COALESCE((SELECT SUM(t.amount_cents) FROM transactions t WHERE t.user_id=b.user_id AND t.category=b.category AND t.type='expense' AND substr(t.date,1,7)=b.month),0) spent FROM budgets b WHERE b.user_id=? AND b.month=? ORDER BY b.category`).all(req.session.userId,month);
  const totalSpent=db.prepare(`SELECT COALESCE(SUM(amount_cents),0) total FROM transactions WHERE user_id=? AND type='expense' AND substr(date,1,7)=?`).get(req.session.userId,month).total/100;
  res.json({month,budgets:rows.map(publicBudget),totalBudget:rows.reduce((s,r)=>s+r.amount_cents,0)/100,totalSpent});
});
app.post('/api/budgets',auth,(req,res)=>{
  const p=validate(z.object({category:z.string().min(1).max(60),amount:amountSchema,month:z.string().regex(monthPattern)}),req.body);if(p.error)return res.status(400).json({error:p.error});if(!categories.expense.includes(p.value.category))return res.status(400).json({error:'Choose a valid expense category.'});
  try{const out=db.prepare('INSERT INTO budgets(user_id,category,amount_cents,month) VALUES(?,?,?,?)').run(req.session.userId,p.value.category,money(p.value.amount),p.value.month);res.status(201).json({id:Number(out.lastInsertRowid)});}catch(e){if(e.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'A budget for this category and month already exists.'});throw e;}
});
app.put('/api/budgets/:id',auth,(req,res)=>{const p=validate(z.object({category:z.string().min(1).max(60),amount:amountSchema,month:z.string().regex(monthPattern)}),req.body);if(p.error)return res.status(400).json({error:p.error});if(!categories.expense.includes(p.value.category))return res.status(400).json({error:'Choose a valid expense category.'});try{const r=db.prepare('UPDATE budgets SET category=?,amount_cents=?,month=? WHERE id=? AND user_id=?').run(p.value.category,money(p.value.amount),p.value.month,Number(req.params.id),req.session.userId);if(!r.changes)return res.status(404).json({error:'Budget not found.'});res.json({ok:true});}catch(e){if(e.code==='SQLITE_CONSTRAINT_UNIQUE')return res.status(409).json({error:'A budget for this category and month already exists.'});throw e;}});
app.delete('/api/budgets/:id',auth,(req,res)=>{const r=db.prepare('DELETE FROM budgets WHERE id=? AND user_id=?').run(Number(req.params.id),req.session.userId);if(!r.changes)return res.status(404).json({error:'Budget not found.'});res.status(204).end();});
app.get('/api/goals',auth,(req,res)=>res.json({goals:db.prepare('SELECT id,title,target_cents/100 target,saved_cents/100 saved,target_date targetDate FROM goals WHERE user_id=? ORDER BY id DESC').all(req.session.userId).map(g=>({...g,remaining:Math.max(0,g.target-g.saved),percent:Math.min(100,Math.round(g.saved*1000/g.target)/10)}))}));
app.post('/api/goals',auth,(req,res)=>{const p=validate(z.object({title:z.string().trim().min(1).max(100),target:amountSchema,saved:z.number().min(0).finite().optional().default(0),targetDate:z.string().refine(validDate).nullable().optional()}),req.body);if(p.error)return res.status(400).json({error:p.error});const out=db.prepare('INSERT INTO goals(user_id,title,target_cents,saved_cents,target_date) VALUES(?,?,?,?,?)').run(req.session.userId,p.value.title,money(p.value.target),money(p.value.saved),p.value.targetDate||null);res.status(201).json({id:Number(out.lastInsertRowid)});});
app.put('/api/goals/:id',auth,(req,res)=>{const p=validate(z.object({title:z.string().trim().min(1).max(100),target:amountSchema,saved:z.number().min(0).finite(),targetDate:z.string().refine(validDate).nullable().optional()}),req.body);if(p.error)return res.status(400).json({error:p.error});const r=db.prepare('UPDATE goals SET title=?,target_cents=?,saved_cents=?,target_date=? WHERE id=? AND user_id=?').run(p.value.title,money(p.value.target),money(p.value.saved),p.value.targetDate||null,Number(req.params.id),req.session.userId);if(!r.changes)return res.status(404).json({error:'Goal not found.'});res.json({ok:true});});
app.delete('/api/goals/:id',auth,(req,res)=>{const r=db.prepare('DELETE FROM goals WHERE id=? AND user_id=?').run(Number(req.params.id),req.session.userId);if(!r.changes)return res.status(404).json({error:'Goal not found.'});res.status(204).end();});
const recurringSchema=z.object({title:z.string().trim().min(1).max(100),amount:amountSchema,type:z.enum(['income','expense']),category:z.string().min(1).max(60),paymentMethod:z.enum(methods),frequency:z.enum(['daily','weekly','monthly','yearly']),startDate:z.string().refine(validDate),endDate:z.string().refine(validDate).nullable().optional()});
app.get('/api/recurring',auth,(req,res)=>res.json({recurring:db.prepare('SELECT id,title,amount_cents/100 amount,type,category,payment_method paymentMethod,frequency,start_date startDate,end_date endDate,active FROM recurring_transactions WHERE user_id=? ORDER BY id DESC').all(req.session.userId)}));
app.post('/api/recurring',auth,(req,res)=>{const p=validate(recurringSchema,req.body);if(p.error)return res.status(400).json({error:p.error});const r=p.value;if(!categories[r.type].includes(r.category))return res.status(400).json({error:'Choose a valid category.'});if(r.endDate&&r.endDate<r.startDate)return res.status(400).json({error:'End date must be on or after the start date.'});const out=db.prepare('INSERT INTO recurring_transactions(user_id,title,amount_cents,type,category,payment_method,frequency,start_date,end_date) VALUES(?,?,?,?,?,?,?,?,?)').run(req.session.userId,r.title,money(r.amount),r.type,r.category,r.paymentMethod,r.frequency,r.startDate,r.endDate||null);generateRecurring(req.session.userId);res.status(201).json({id:Number(out.lastInsertRowid)});});
app.put('/api/recurring/:id',auth,(req,res)=>{const p=validate(recurringSchema,req.body);if(p.error)return res.status(400).json({error:p.error});const r=p.value;if(!categories[r.type].includes(r.category)||r.endDate&&r.endDate<r.startDate)return res.status(400).json({error:'Invalid category or date range.'});const out=db.prepare('UPDATE recurring_transactions SET title=?,amount_cents=?,type=?,category=?,payment_method=?,frequency=?,start_date=?,end_date=? WHERE id=? AND user_id=?').run(r.title,money(r.amount),r.type,r.category,r.paymentMethod,r.frequency,r.startDate,r.endDate||null,Number(req.params.id),req.session.userId);if(!out.changes)return res.status(404).json({error:'Recurring rule not found.'});res.json({ok:true});});
app.delete('/api/recurring/:id',auth,(req,res)=>{const out=db.prepare('DELETE FROM recurring_transactions WHERE id=? AND user_id=?').run(Number(req.params.id),req.session.userId);if(!out.changes)return res.status(404).json({error:'Recurring rule not found.'});res.status(204).end();});
app.get('/api/analytics/summary',auth,(req,res)=>{
  const month=req.query.month||new Date().toISOString().slice(0,7);if(!monthPattern.test(month))return res.status(400).json({error:'Month must use YYYY-MM.'});const userId=req.session.userId;
  const sums=db.prepare(`SELECT type,SUM(amount_cents) total FROM transactions WHERE user_id=? AND substr(date,1,7)=? GROUP BY type`).all(userId,month);const income=(sums.find(x=>x.type==='income')?.total||0)/100;const expenses=(sums.find(x=>x.type==='expense')?.total||0)/100;
  const categoriesData=db.prepare(`SELECT category,SUM(amount_cents)/100 amount FROM transactions WHERE user_id=? AND type='expense' AND substr(date,1,7)=? GROUP BY category ORDER BY amount DESC`).all(userId,month);
  const recent=db.prepare('SELECT * FROM transactions WHERE user_id=? AND substr(date,1,7)=? ORDER BY date DESC,id DESC LIMIT 6').all(userId,month).map(publicTransaction);
  const budgetRows=db.prepare(`SELECT amount_cents FROM budgets WHERE user_id=? AND month=?`).all(userId,month);
  res.json({month,income,expenses,balance:income-expenses,savings:income-expenses,savingsRate:income?Math.round((income-expenses)*1000/income)/10:0,budget:budgetRows.reduce((a,b)=>a+b.amount_cents,0)/100,budgetSpent:expenses,categories:categoriesData,topCategories:categoriesData.slice(0,5),recent});
});
app.get('/api/analytics/categories',auth,(req,res)=>{
  const month=req.query.month||new Date().toISOString().slice(0,7);
  if(!monthPattern.test(month))return res.status(400).json({error:'Month must use YYYY-MM.'});
  const rows=db.prepare(`SELECT category,SUM(amount_cents)/100 amount FROM transactions WHERE user_id=? AND type='expense' AND substr(date,1,7)=? GROUP BY category ORDER BY amount DESC`).all(req.session.userId,month);
  res.json({month,categories:rows});
});
app.get('/api/analytics/monthly-trends',auth,(req,res)=>{const userId=req.session.userId;
  const trends=db.prepare(`SELECT substr(date,1,7) month,type,SUM(amount_cents)/100 amount FROM transactions WHERE user_id=? AND date>=date('now','start of month','-5 months') GROUP BY month,type ORDER BY month`).all(userId);
  const savings=db.prepare(`SELECT substr(date,1,7) month,SUM(CASE WHEN type='income' THEN amount_cents ELSE -amount_cents END)/100 amount FROM transactions WHERE user_id=? AND date>=date('now','start of month','-5 months') GROUP BY month ORDER BY month`).all(userId);
  res.json({trends,savings});
});
app.get('/api/reports/export.csv',auth,(req,res)=>{const from=req.query.from;const to=req.query.to;if((from&&!validDate(from))||(to&&!validDate(to))||(from&&to&&from>to))return res.status(400).json({error:'Provide a valid date range.'});const rows=db.prepare(`SELECT title,amount_cents/100 amount,type,category,payment_method,date,notes FROM transactions WHERE user_id=? AND (? IS NULL OR date>=?) AND (? IS NULL OR date<=?) ORDER BY date DESC`).all(req.session.userId,from||null,from||null,to||null,to||null);const csvCell=(value)=>`"${String(value??'').replaceAll('"','""')}"`;const csv=['Title,Amount,Type,Category,Payment method,Date,Notes',...rows.map(r=>[r.title,r.amount,r.type,r.category,r.payment_method,r.date,r.notes].map(csvCell).join(','))].join('\r\n');res.type('text/csv').set('Content-Disposition','attachment; filename="pocketwise-report.csv"').send(csv);});
app.get('/api',(_req,res)=>res.json({name:'PocketWise API',version:1}));
app.use('/api',(req,res)=>res.status(404).json({error:'API endpoint not found.'}));
app.use(express.static(path.join(__dirname,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
app.use((err,_req,res,_next)=>{console.error(err);if(res.headersSent)return;res.status(500).json({error:'Something went wrong. Please try again.'});});
if(require.main===module)app.listen(PORT,()=>console.log(`PocketWise is available at http://localhost:${PORT}`));
module.exports={app,db};
