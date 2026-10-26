const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const API = '/api';
const fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const today = new Date();
const currentMonth = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
let state = { user:null, meta:null, page:'dashboard', month:currentMonth, transactions:[], budgets:[], goals:[], recurring:[], charts:{} };
const dialog = $('#form-dialog');
const dialogForm = $('#dialog-form');
let toastTimer;

async function request(url, options = {}) {
  const response = await fetch(`${API}${url}`, { credentials:'same-origin', ...options, headers:{ ...(options.body ? {'Content-Type':'application/json'} : {}), ...options.headers } });
  if (response.status === 204) return null;
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || 'Request failed. Please try again.');
  return data;
}
function notify(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('error',error); toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>toast.classList.remove('show'),3000);
}
function escapeHtml(value='') { return String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function dateDisplay(iso) { if(!iso)return '—';const [y,m,d]=iso.split('-');return `${d}-${m}-${y}`; }
function pageHeader(title, subtitle, action='') { return `<div class="page-title-row"><div><p class="eyebrow">POCKETWISE / ${escapeHtml(state.month)}</p><h1 class="page-title">${title}</h1><p class="page-subtitle">${subtitle}</p></div>${action}</div>`; }
function money(value) { return fmt.format(Number(value)||0); }
function empty(label, icon='◇') { return `<div class="empty-state"><div class="empty-mark">${icon}</div>${label}</div>`; }
function categoryOptions(type, selected='') { return (state.meta.categories[type]||[]).map(c=>`<option ${c===selected?'selected':''} value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join(''); }
function methodOptions(selected='UPI') { return state.meta.methods.map(m=>`<option ${m===selected?'selected':''} value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join(''); }
function destroyCharts() { Object.values(state.charts).forEach(c=>c?.destroy());state.charts={}; }
function setPage(page) {
  state.page=page; $$('.page-view').forEach(el=>el.hidden=true); $(`#page-${page}`).hidden=false;
  $$('.nav-item[data-page]').forEach(el=>el.classList.toggle('active',el.dataset.page===page));
  const names={dashboard:'Overview',transactions:'Transactions',budgets:'Budgets',goals:'Savings goals',recurring:'Recurring',reports:'Reports',settings:'Settings'};
  $('#page-crumb').textContent=names[page];$('#sidebar').classList.remove('open');renderPage();
}
async function loadBase() {
  $('#global-month').value=state.month;
  const [meta,summary,transactions,budgets,goals,recurring,trends]=await Promise.all([
    request('/meta'),request(`/analytics/summary?month=${state.month}`),request('/transactions'),request(`/budgets?month=${state.month}`),request('/goals'),request('/recurring'),request('/analytics/monthly-trends')
  ]);
  state.meta=meta;state.summary=summary;state.transactions=transactions.transactions;state.budgets=budgets.budgets;state.budgetSummary=budgets;state.goals=goals.goals;state.recurring=recurring.recurring;state.trends=trends.trends;
}
async function refresh() { try { await loadBase();renderPage(); } catch(e) { notify(e.message,true); } }
function renderPage() {
  destroyCharts();
  ({dashboard:renderDashboard,transactions:renderTransactions,budgets:renderBudgets,goals:renderGoals,recurring:renderRecurring,reports:renderReports,settings:renderSettings}[state.page]||renderDashboard)();
}
function transactionRows(rows, actions=false) {
  if(!rows.length)return `<tr><td colspan="${actions?6:5}">${empty('No transactions for this period yet.')}</td></tr>`;
  return rows.map(t=>`<tr><td>${escapeHtml(t.title)}${t.notes?`<div class="muted">${escapeHtml(t.notes)}</div>`:''}</td><td><span class="category-pill">${escapeHtml(t.category)}</span></td><td>${dateDisplay(t.date)}</td><td class="${t.type==='income'?'amount-income':'amount-expense'}">${t.type==='income'?'+':'−'}${money(t.amount)}</td>${actions?`<td><div class="table-actions"><button data-edit-tx="${t.id}">Edit</button><button data-delete-tx="${t.id}">Delete</button></div></td>`:''}</tr>`).join('');
}
function renderDashboard() {
  const s=state.summary;
  const welcome=`Good ${greeting()}, ${escapeHtml(state.user.name.split(' ')[0])}.`;
  $('#page-dashboard').innerHTML=`${pageHeader(welcome,'Here is the shape of your money this month.','<button class="button button-secondary" id="dash-add">＋ Add transaction</button>')}
  <div class="dashboard-grid">
    <article class="metric-card"><div class="metric-label">Income <span class="metric-glyph">↗</span></div><div class="metric-value">${money(s.income)}</div><div class="metric-foot positive">Received this month</div></article>
    <article class="metric-card expense"><div class="metric-label">Expenses <span class="metric-glyph">↘</span></div><div class="metric-value">${money(s.expenses)}</div><div class="metric-foot">Spent this month</div></article>
    <article class="metric-card balance"><div class="metric-label">Net balance <span class="metric-glyph">◈</span></div><div class="metric-value">${money(s.balance)}</div><div class="metric-foot ${s.balance>=0?'positive':'negative'}">${s.savingsRate}% savings rate</div></article>
    <article class="metric-card"><div class="metric-label">Budget used <span class="metric-glyph">◷</span></div><div class="metric-value">${s.budget?Math.round(s.budgetSpent*100/s.budget):0}%</div><div class="metric-foot">${money(s.budgetSpent)} of ${money(s.budget)} planned</div></article>
    <section class="panel chart-panel"><div class="panel-header"><div><h2 class="section-heading">Income and expenses</h2><p class="section-caption">A simple look at this month</p></div><span class="status-label">${escapeHtml(state.month)}</span></div><div class="chart-wrap"><canvas id="income-chart" aria-label="Income compared with expenses"></canvas><div id="income-chart-empty" class="chart-empty" hidden></div></div></section>
    <section class="panel category-panel"><div class="panel-header"><div><h2 class="section-heading">Where it goes</h2><p class="section-caption">Spending by category</p></div><button class="text-button" data-go="reports">View report →</button></div><div id="category-content"></div></section>
    <section class="panel transactions-panel"><div class="panel-header"><div><h2 class="section-heading">Recent transactions</h2><p class="section-caption">Your latest activity this month</p></div><button class="text-button" data-go="transactions">All transactions →</button></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Transaction</th><th>Category</th><th>Date</th><th>Amount</th></tr></thead><tbody>${transactionRows(s.recent)}</tbody></table></div></section>
    <section class="panel budget-summary-panel"><div class="panel-header"><div><h2 class="section-heading">Budget pulse</h2><p class="section-caption">Category limits for this month</p></div><button class="text-button" data-go="budgets">Manage →</button></div><div class="list-progress">${state.budgets.length?state.budgets.slice(0,5).map(b=>`<div class="progress-item"><div class="progress-copy"><strong>${escapeHtml(b.category)}</strong><span>${money(b.spent)} / ${money(b.amount)}</span></div><div class="progress-track"><div class="progress-fill ${b.percent>100?'over':''}" style="width:${Math.min(100,b.percent)}%"></div></div></div>`).join(''):empty('Set your first monthly budget.','◷')}</div></section>
  </div>`;
  $('#dash-add').onclick=()=>openTransactionForm();
  const cats=s.categories;$('#category-content').innerHTML=cats.length?`<div class="chart-wrap" style="height:158px"><canvas id="category-chart" aria-label="Spending by category"></canvas></div><div class="legend-list">${cats.slice(0,4).map((c,i)=>`<div class="legend-row"><span class="legend-dot" style="background:${palette[i%palette.length]}"></span><span class="legend-name">${escapeHtml(c.category)}</span><span class="legend-value">${money(c.amount)}</span></div>`).join('')}</div>`:empty('Your category breakdown will appear after your first expense.');
  if(window.Chart){ if(s.income||s.expenses)state.charts.income=new Chart($('#income-chart'),{type:'bar',data:{labels:['This month'],datasets:[{label:'Income',data:[s.income],backgroundColor:'#6b9b78',borderRadius:5,maxBarThickness:40},{label:'Expenses',data:[s.expenses],backgroundColor:'#d47b6d',borderRadius:5,maxBarThickness:40}]},options:chartOptions()});
    if(cats.length)state.charts.category=new Chart($('#category-chart'),{type:'doughnut',data:{labels:cats.map(c=>c.category),datasets:[{data:cats.map(c=>c.amount),backgroundColor:cats.map((_,i)=>palette[i%palette.length]),borderWidth:0,hoverOffset:5}]},options:{...chartOptions(),cutout:'72%',plugins:{legend:{display:false}}}});
  }
  if(!s.income&&!s.expenses){$('#income-chart-empty').textContent='Add transactions to see your cash flow.';$('#income-chart-empty').hidden=false;}
  wirePageActions();
}
function greeting(){const h=new Date().getHours();return h<12?'morning':h<18?'afternoon':'evening';}
const palette=['#719c7a','#d6ad73','#8474ad','#75a8a0','#cf7c6e','#a5ad70','#6692a0','#c289a0'];
function chartOptions(){return{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{usePointStyle:true,boxWidth:7,boxHeight:7,color:'#7e867e',font:{family:'DM Sans',size:10},padding:16}}},scales:{x:{grid:{display:false},ticks:{color:'#8c938c',font:{size:10}}},y:{beginAtZero:true,grid:{color:'#f0f1ee'},ticks:{color:'#8c938c',font:{size:9},callback:v=>`₹${Number(v).toLocaleString('en-IN')}`}}}};}
function renderTransactions() {
  $('#page-transactions').innerHTML=`${pageHeader('Transactions','All your money movement, in one place.',`<button class="button button-primary" id="tx-add">＋ Add transaction</button>`)}<section class="panel"><div class="filters-row"><input id="tx-search" class="field search" placeholder="Search transactions" aria-label="Search transactions"><select id="tx-type" class="select-field"><option value="">All types</option><option value="income">Income</option><option value="expense">Expense</option></select><select id="tx-category" class="select-field"><option value="">All categories</option>${[...state.meta.categories.expense,...state.meta.categories.income].map(c=>`<option>${escapeHtml(c)}</option>`).join('')}</select><input id="tx-from" type="date" class="field" aria-label="From date"><input id="tx-to" type="date" class="field" aria-label="To date"><select id="tx-sort" class="select-field"><option value="date">Newest first</option><option value="amount">Amount</option></select></div><div class="table-wrap"><table class="data-table"><thead><tr><th>Title</th><th>Category</th><th>Date</th><th>Amount</th><th>Method</th><th>Actions</th></tr></thead><tbody id="tx-body"></tbody></table></div></section>`;
  $('#tx-add').onclick=()=>openTransactionForm(); ['tx-search','tx-type','tx-category','tx-from','tx-to','tx-sort'].forEach(id=>$('#'+id).addEventListener('input',filterTransactions));filterTransactions();
}
function filterTransactions(){const q=$('#tx-search').value.toLowerCase(),type=$('#tx-type').value,cat=$('#tx-category').value,from=$('#tx-from').value,to=$('#tx-to').value,sort=$('#tx-sort').value;
  const rows=state.transactions.filter(t=>(!q||t.title.toLowerCase().includes(q))&&(!type||t.type===type)&&(!cat||t.category===cat)&&(!from||t.date>=from)&&(!to||t.date<=to)).sort((a,b)=>sort==='amount'?b.amount-a.amount:b.date.localeCompare(a.date));
  $('#tx-body').innerHTML=rows.length?rows.map(t=>`<tr><td>${escapeHtml(t.title)}${t.notes?`<div class="muted">${escapeHtml(t.notes)}</div>`:''}</td><td><span class="category-pill">${escapeHtml(t.category)}</span></td><td>${dateDisplay(t.date)}</td><td class="${t.type==='income'?'amount-income':'amount-expense'}">${t.type==='income'?'+':'−'}${money(t.amount)}</td><td>${escapeHtml(t.paymentMethod)}</td><td>${t.recurringId?'<span class="status-label">Recurring</span>':`<div class="table-actions"><button data-edit-tx="${t.id}">Edit</button><button data-delete-tx="${t.id}">Delete</button></div>`}</td></tr>`).join(''):`<tr><td colspan="6">${empty('No transactions match these filters.')}</td></tr>`;wirePageActions();
}
function renderBudgets(){
  const budgets=state.budgets;
  $('#page-budgets').innerHTML=`${pageHeader('Monthly budgets','Put a little structure around your spending.',`<button class="button button-primary" id="budget-add">＋ Create budget</button>`)}<section class="panel"><div class="panel-header"><div><h2 class="section-heading">${new Date(`${state.month}-01T12:00:00`).toLocaleDateString('en-IN',{month:'long',year:'numeric'})}</h2><p class="section-caption">${money(state.budgetSummary.totalSpent)} spent of ${money(state.budgetSummary.totalBudget)} planned</p></div><span class="status-label">${budgets.length} categories</span></div><div class="budget-list">${budgets.length?budgets.map(b=>`<article class="budget-card"><div class="budget-top"><strong>${escapeHtml(b.category)}</strong><div class="table-actions"><button data-edit-budget="${b.id}">Edit</button><button data-delete-budget="${b.id}">Delete</button></div></div><div class="budget-meta"><span>${money(b.spent)} spent</span><span>${money(Math.max(0,b.remaining))} remaining of ${money(b.amount)}</span></div><div class="progress-track"><div class="progress-fill ${b.percent>100?'over':''}" style="width:${Math.min(100,b.percent)}%"></div></div><div class="budget-meta"><span>${b.percent>100?`Over by ${money(b.spent-b.amount)}`:'Budget used'}</span><span class="${b.percent>100?'danger-text':''}">${b.percent}%</span></div></article>`).join(''):empty('No budgets set for this month. Create one to keep spending on track.','◷')}</div></section>`;
  $('#budget-add').onclick=()=>openBudgetForm();wirePageActions();
}
function renderGoals(){
 $('#page-goals').innerHTML=`${pageHeader('Savings goals','Make room for the things you are working toward.',`<button class="button button-primary" id="goal-add">＋ New goal</button>`)}<div class="goal-list">${state.goals.length?state.goals.map(g=>`<article class="panel goal-card"><div class="goal-top"><div><p class="eyebrow">SAVINGS GOAL</p><strong>${escapeHtml(g.title)}</strong></div><div class="table-actions"><button data-edit-goal="${g.id}">Update progress</button><button data-delete-goal="${g.id}">Delete</button></div></div><div class="budget-top"><strong>${money(g.saved)} <span class="goal-remaining">saved of ${money(g.target)}</span></strong><span class="goal-highlight">${g.percent}%</span></div><div class="progress-track goal-progress"><div class="progress-fill" style="width:${g.percent}%"></div></div><div class="goal-top"><span class="goal-remaining">${money(g.remaining)} to go</span><span class="goal-remaining">${g.targetDate?`Target ${dateDisplay(g.targetDate)}`:'No target date'}</span></div></article>`).join(''):empty('Your next big thing starts with a goal. Add one to track your progress.','◎')}</div>`;
 $('#goal-add').onclick=()=>openGoalForm();wirePageActions();
}
function renderRecurring(){
 $('#page-recurring').innerHTML=`${pageHeader('Recurring transactions','Keep regular income and bills on autopilot.',`<button class="button button-primary" id="recurring-add">＋ Add recurring</button>`)}<div class="recurring-list">${state.recurring.length?state.recurring.map(r=>`<article class="panel recurring-card"><div class="recurring-top"><div><p class="eyebrow">${escapeHtml(r.frequency)} ${escapeHtml(r.type)}</p><strong>${escapeHtml(r.title)}</strong><div class="recurring-details">${escapeHtml(r.category)} · ${escapeHtml(r.paymentMethod)} · Starts ${dateDisplay(r.startDate)}${r.endDate?` · Ends ${dateDisplay(r.endDate)}`:''}</div></div><div class="recurring-top"><strong class="${r.type==='income'?'amount-income':'amount-expense'}">${r.type==='income'?'+':'−'}${money(r.amount)}</strong><div class="table-actions"><button data-edit-recurring="${r.id}">Edit</button><button data-delete-recurring="${r.id}">Delete</button></div></div></div></article>`).join(''):empty('No recurring transactions yet. Add salary, rent, bills, or subscriptions.','⟳')}</div>`;
 $('#recurring-add').onclick=()=>openRecurringForm();wirePageActions();
}
function renderReports(){
 $('#page-reports').innerHTML=`${pageHeader('Reports','Explore patterns and take your records with you.')}<section class="panel"><div class="report-controls"><label>From<input class="field" type="date" id="report-from"></label><label>To<input class="field" type="date" id="report-to"></label><button id="report-export" class="button button-primary">↓ Export CSV</button></div></section><div class="reports-layout" style="margin-top:16px"><section class="panel"><div class="panel-header"><div><h2 class="section-heading">Six-month cash flow</h2><p class="section-caption">Income and expenses over time</p></div></div><div class="chart-wrap"><canvas id="trend-chart" aria-label="Six month income and expense chart"></canvas><div id="trend-chart-empty" class="chart-empty" hidden></div></div></section><section class="panel"><div class="panel-header"><div><h2 class="section-heading">Top spending categories</h2><p class="section-caption">${escapeHtml(state.month)}</p></div></div><div class="top-five">${state.summary.topCategories.length?state.summary.topCategories.map((c,i)=>`<div class="progress-item"><div class="progress-copy"><strong>${i+1}. ${escapeHtml(c.category)}</strong><span>${money(c.amount)}</span></div><div class="progress-track"><div class="progress-fill" style="width:${state.summary.expenses?Math.min(100,c.amount*100/state.summary.expenses):0}%"></div></div></div>`).join(''):empty('No expenses to report this month.')}</div></section></div>`;
  $('#report-export').onclick=async()=>{try{const from=$('#report-from').value,to=$('#report-to').value;const params=new URLSearchParams();if(from)params.set('from',from);if(to)params.set('to',to);const response=await fetch(`${API}/reports/export.csv?${params}`,{credentials:'same-origin'});if(!response.ok){const data=await response.json();throw new Error(data.error);}const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='pocketwise-report.csv';a.click();URL.revokeObjectURL(url);notify('CSV report downloaded.');}catch(e){notify(e.message,true);}};
  if(window.Chart){const monthNames=[...new Set(state.trends.map(r=>r.month))].sort();const by=(type)=>monthNames.map(month=>state.trends.find(r=>r.month===month&&r.type===type)?.amount||0);state.charts.trend=new Chart($('#trend-chart'),{type:'line',data:{labels:monthNames.map(m=>{const [y,n]=m.split('-');return new Date(Number(y),Number(n)-1).toLocaleDateString('en-IN',{month:'short'})}),datasets:[{label:'Income',data:by('income'),borderColor:'#629271',backgroundColor:'#629271',tension:.32},{label:'Expenses',data:by('expense'),borderColor:'#cf7669',backgroundColor:'#cf7669',tension:.32}]},options:chartOptions()});}
  if(!state.trends.length){$('#trend-chart-empty').textContent='Add transactions to build your six-month trend.';$('#trend-chart-empty').hidden=false;}
}
function renderSettings(){ $('#page-settings').innerHTML=`${pageHeader('Settings','Manage your account and local preferences.')}<section class="panel"><h2 class="section-heading">Account</h2><p class="settings-copy">Signed in as <strong>${escapeHtml(state.user.name)}</strong> (${escapeHtml(state.user.email)}). PocketWise stores your information in a local SQLite database on this computer. Currency is set to Indian Rupees (INR), with dates displayed as DD-MM-YYYY.</p><button id="settings-logout" class="button button-secondary">Sign out</button></section>`;$('#settings-logout').onclick=logout; }
function wirePageActions(){
 $$('[data-go]').forEach(b=>b.onclick=()=>setPage(b.dataset.go));
 $$('[data-edit-tx]').forEach(b=>b.onclick=()=>openTransactionForm(state.transactions.find(t=>t.id===Number(b.dataset.editTx))));
 $$('[data-delete-tx]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this transaction? This cannot be undone.'))try{await request(`/transactions/${b.dataset.deleteTx}`,{method:'DELETE'});notify('Transaction deleted.');await refresh();}catch(e){notify(e.message,true);}});
 $$('[data-edit-budget]').forEach(b=>b.onclick=()=>openBudgetForm(state.budgets.find(x=>x.id===Number(b.dataset.editBudget))));
 $$('[data-delete-budget]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this monthly budget?'))try{await request(`/budgets/${b.dataset.deleteBudget}`,{method:'DELETE'});notify('Budget deleted.');await refresh();}catch(e){notify(e.message,true);}});
 $$('[data-edit-goal]').forEach(b=>b.onclick=()=>openGoalForm(state.goals.find(x=>x.id===Number(b.dataset.editGoal))));
 $$('[data-delete-goal]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this savings goal?'))try{await request(`/goals/${b.dataset.deleteGoal}`,{method:'DELETE'});notify('Goal deleted.');await refresh();}catch(e){notify(e.message,true);}});
 $$('[data-edit-recurring]').forEach(b=>b.onclick=()=>openRecurringForm(state.recurring.find(x=>x.id===Number(b.dataset.editRecurring))));
 $$('[data-delete-recurring]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this recurring rule? Existing transactions will be kept.'))try{await request(`/recurring/${b.dataset.deleteRecurring}`,{method:'DELETE'});notify('Recurring rule deleted.');await refresh();}catch(e){notify(e.message,true);}});
}
function showForm(title,subtitle,fields,submitLabel='Save'){
 dialogForm.innerHTML=`<div class="dialog-form"><h2>${title}</h2><p class="dialog-copy">${subtitle}</p><div class="form-grid">${fields}</div><div class="dialog-actions"><button type="button" class="button button-secondary" id="form-cancel">Cancel</button><button class="button button-primary" type="submit">${submitLabel}</button></div></div>`;
 $('#form-cancel').onclick=()=>dialog.close();dialog.showModal();
}
function input(name,label,value='',type='text',attrs=''){return `<label>${label}<input name="${name}" type="${type}" value="${escapeHtml(value)}" ${attrs} required></label>`;}
function openTransactionForm(item=null){
 const type=item?.type||'expense';showForm(item?'Edit transaction':'Add transaction','Keep the details accurate. PocketWise updates your overview automatically.',`${input('title','Title',item?.title||'','text','maxlength="100"')}${input('amount','Amount in INR',item?.amount||'','number','min="0.01" step="0.01"')}
 <label>Type<select name="type" id="form-tx-type"><option value="expense" ${type==='expense'?'selected':''}>Expense</option><option value="income" ${type==='income'?'selected':''}>Income</option></select></label><label>Category<select name="category" id="form-tx-category">${categoryOptions(type,item?.category)}</select></label>
 <label>Payment method<select name="paymentMethod">${methodOptions(item?.paymentMethod||'UPI')}</select></label>${input('date','Date',item?.date||today.toISOString().slice(0,10),'date')}
 <label class="span-all">Notes<textarea name="notes" maxlength="500">${escapeHtml(item?.notes||'')}</textarea></label>` ,item?'Update transaction':'Save transaction');
 $('#form-tx-type').onchange=e=>$('#form-tx-category').innerHTML=categoryOptions(e.target.value);
 dialogForm.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(dialogForm));data.amount=Number(data.amount);try{await request(`/transactions${item?`/${item.id}`:''}`,{method:item?'PUT':'POST',body:JSON.stringify(data)});dialog.close();notify(item?'Transaction updated.':'Transaction added.');await refresh();}catch(err){notify(err.message,true);}};
}
function openBudgetForm(item=null){
 showForm(item?'Edit budget':'Create a budget','Set a monthly limit for an expense category.',`<label class="span-all">Expense category<select name="category">${categoryOptions('expense',item?.category)}</select></label>${input('amount','Monthly limit in INR',item?.amount||'','number','min="0.01" step="0.01"')}${input('month','Month',item?.month||state.month,'month')}`,item?'Update budget':'Create budget');
 dialogForm.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(dialogForm));data.amount=Number(data.amount);try{await request(`/budgets${item?`/${item.id}`:''}`,{method:item?'PUT':'POST',body:JSON.stringify(data)});dialog.close();notify(item?'Budget updated.':'Budget created.');await refresh();}catch(err){notify(err.message,true);}};
}
function openGoalForm(item=null){
 showForm(item?'Update savings goal':'Create a savings goal','Track a target and the amount you have saved so far.',`${input('title','Goal name',item?.title||'')}${input('target','Target amount in INR',item?.target||'','number','min="0.01" step="0.01"')}${input('saved','Already saved in INR',item?.saved??0,'number','min="0" step="0.01"')}${input('targetDate','Target date',item?.targetDate||'','date','')}`,item?'Update goal':'Create goal');
 $('#dialog-form [name="targetDate"]').required=false;dialogForm.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(dialogForm));data.target=Number(data.target);data.saved=Number(data.saved);data.targetDate=data.targetDate||null;try{await request(`/goals${item?`/${item.id}`:''}`,{method:item?'PUT':'POST',body:JSON.stringify(data)});dialog.close();notify(item?'Goal updated.':'Goal created.');await refresh();}catch(err){notify(err.message,true);}};
}
function openRecurringForm(item=null){
 const type=item?.type||'expense';showForm(item?'Edit recurring rule':'Add recurring transaction','Occurrences are generated once when a due date arrives.',`${input('title','Title',item?.title||'')}${input('amount','Amount in INR',item?.amount||'','number','min="0.01" step="0.01"')}<label>Type<select name="type" id="form-rec-type"><option value="expense" ${type==='expense'?'selected':''}>Expense</option><option value="income" ${type==='income'?'selected':''}>Income</option></select></label><label>Category<select name="category" id="form-rec-category">${categoryOptions(type,item?.category)}</select></label><label>Payment method<select name="paymentMethod">${methodOptions(item?.paymentMethod||'UPI')}</select></label><label>Frequency<select name="frequency">${['daily','weekly','monthly','yearly'].map(f=>`<option ${f===item?.frequency?'selected':''}>${f}</option>`).join('')}</select></label>${input('startDate','Start date',item?.startDate||today.toISOString().slice(0,10),'date')}${input('endDate','Optional end date',item?.endDate||'','date','')}</div>`,item?'Update rule':'Create rule');
 $('#dialog-form [name="endDate"]').required=false;$('#form-rec-type').onchange=e=>$('#form-rec-category').innerHTML=categoryOptions(e.target.value);
 dialogForm.onsubmit=async e=>{e.preventDefault();const data=Object.fromEntries(new FormData(dialogForm));data.amount=Number(data.amount);data.endDate=data.endDate||null;try{await request(`/recurring${item?`/${item.id}`:''}`,{method:item?'PUT':'POST',body:JSON.stringify(data)});dialog.close();notify(item?'Recurring rule updated.':'Recurring rule created.');await refresh();}catch(err){notify(err.message,true);}};
}
async function logout(){try{await request('/auth/logout',{method:'POST'});}finally{state.user=null;$('#auth-form').reset();authMode(false);$('#app-shell').hidden=true;$('#auth-screen').hidden=false;}};
function authMode(register){$('#auth-title').textContent=register?'Create your account':'Welcome back';$('#auth-subtitle').textContent=register?'Start with a clearer view of your money.':'Sign in to your PocketWise account.';$('#name-field').hidden=!register;$('#auth-form [name="name"]').required=register;$('#auth-form [name="password"]').autocomplete=register?'new-password':'current-password';$('#auth-submit').textContent=register?'Create account':'Sign in';$('#auth-switch-text').textContent=register?'Already have an account?':'New to PocketWise?';$('#auth-switch').textContent=register?'Sign in':'Create an account';$('#auth-form').dataset.mode=register?'register':'login';}
async function initialize(){
 $('#auth-form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,data=Object.fromEntries(new FormData(form));try{const result=await request(`/auth/${form.dataset.mode}`,{method:'POST',body:JSON.stringify(data)});state.user=result.user;await launch();}catch(err){notify(err.message,true);}};
 $('#auth-switch').onclick=()=>authMode($('#auth-form').dataset.mode!=='register');$('#logout-button').onclick=logout;
 $$('.nav-item[data-page]').forEach(b=>b.onclick=()=>setPage(b.dataset.page));$('#quick-add').onclick=()=>openTransactionForm();$('#mobile-menu').onclick=()=>$('#sidebar').classList.toggle('open');
 $('#global-month').onchange=async e=>{state.month=e.target.value||currentMonth;await refresh();};
 try{const me=await request('/auth/me');state.user=me.user;await launch();}catch{authMode(false);$('#auth-screen').hidden=false;}
}
async function launch(){ $('#auth-screen').hidden=true;$('#app-shell').hidden=false;$('#user-name').textContent=state.user.name;$('#avatar').textContent=(state.user.name[0]||'P').toUpperCase();await loadBase();setPage(state.page); }
document.addEventListener('DOMContentLoaded',()=>document.body.classList.add('ready'));
document.addEventListener('DOMContentLoaded',initialize);
