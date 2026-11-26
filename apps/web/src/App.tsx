import { BranchSettings, type Locations } from './BranchSettings';
import WorkspaceSettings from './WorkspaceSettings';
import { StaffLogin, roleNames, type StaffIdentity } from './StaffLogin';
import { ActivityLogs, DayLook } from './OperationsReview';
import BulkImport from './BulkImport';
import { CatalogueActions, CatalogueManagement, type ManagedCategory as Category, type ManagedProduct as Product, type Selection } from './CatalogueManagement';
import { StockNotifications } from './StockNotifications';
import QuickSale from './QuickSale';
import { CategoryOptions } from './category-options';
import WarehouseDashboard from './WarehouseDashboard';
import { ListFilters, emptyFilters, matchesFilters } from './ListFilters';
import { prepareProductPhoto } from './product-photo';
import { formatProductPrice, QueryStatus, useQuery } from './warehouse-ui';
import Customers from './Customers';
import Sales, { FinancialReports, SalesDashboard } from './Sales';
import { api, base, send, setBranch } from './api';
import Inventory from './Inventory';
import Purchases from './Purchases';
import Suppliers from './Suppliers';
import {useEffect,useState} from 'react';
import {LayoutDashboard,Package,Tags,Warehouse,ShoppingCart,Truck,Users,Wallet,BarChart3,Settings,Search,Plus,RefreshCw,AlertCircle,X,Upload,Boxes,ReceiptText,CalendarDays,ListChecks,LogOut,ShieldCheck,RotateCcw} from 'lucide-react';
type Dashboard={products:number;availableUnits:number;inventoryCost:number;lowStock:{sku:string;name:string;availableQty:number}[];byCategory:{name:string;qty:number}[]};
const initial={sku:'',name:'',categoryId:'',costPrice:'',salePrice:''};
const initialVariant={size:'M',color:'Black',qty:'0'};
const nav=[['Dashboard',LayoutDashboard],['Quick Sale',ReceiptText],['Products',Package],['Categories',Tags],['Inventory / Stock',Warehouse],['Purchases',ShoppingCart],['Sales & Distribution',Truck],['Customers / Suppliers',Users],['Payments',Wallet],['Reports',BarChart3],['Day Look',CalendarDays],['Activity Logs',ListChecks],['Returns',RotateCcw],['Staff & Permissions',ShieldCheck],['Shops & Branches',Warehouse],['Settings',Settings]] as const;
function App(){
  const [user,setUser]=useState<StaffIdentity|null>(null);
  const [checking,setChecking]=useState(true);
  useEffect(()=>{
    const controller=new AbortController();
    api<StaffIdentity>('/auth/session',{signal:controller.signal})
      .then(identity=>{if(!controller.signal.aborted)setUser(identity);})
      .catch(()=>{})
      .finally(()=>{if(!controller.signal.aborted)setChecking(false);});
    const expire=()=>setUser(null);
    window.addEventListener('garmentpro-session-expired',expire);
    return ()=>{controller.abort();window.removeEventListener('garmentpro-session-expired',expire);};
  },[]);
  return user ? <LocationWorkspace key={user.id} user={user} onSignOut={()=>setUser(null)}/>
    : <StaffLogin checking={checking} onLogin={setUser}/>;
}

const emptyLocations: Locations = { shops: [], branches: [], legacyAllowed: false };
function LocationWorkspace({ user, onSignOut }: { user: StaffIdentity; onSignOut: () => void }) {
  const [revision, setRevision] = useState(0);
  const key = 'garmentpro-branch-' + user.id;
  const [selection, setSelection] = useState(() => sessionStorage.getItem(key) ?? '');
  const locations = useQuery('/locations', emptyLocations, revision);
  const selected = locations.data.branches.find(branch => branch.id === selection)
    ?? (locations.data.legacyAllowed ? undefined : locations.data.branches[0]);
  setBranch(selected?.id ?? '');
  if (locations.loading && locations.data === emptyLocations) return <main className="staff-login"><p role="status">Loading assigned branches…</p></main>;
  if (locations.error || (!locations.data.legacyAllowed && !selected)) return <main className="staff-login studio-shell">
    <section className="panel staff-login-card"><h1>Branch access</h1>
      <p>{locations.error || 'Ask your administrator to assign you to a branch.'}</p>
      <button type="button" className="textbtn" onClick={()=>setRevision(value=>value+1)}>Refresh access</button>
      <button type="button" className="textbtn" onClick={async()=>{await send('/auth/logout','POST');onSignOut();}}>Sign out</button>
    </section></main>;
  const effective = selected ? { ...user, permissions: selected.permissions } : user;
  return <Workspace key={selected?.id ?? 'original'} user={effective} onSignOut={onSignOut} locations={locations.data}
    branchId={selected?.id ?? ''} onBranch={id=>{sessionStorage.setItem(key,id);setSelection(id);}}
    reloadLocations={()=>setRevision(value=>value+1)}/>;
}

function Workspace({user,onSignOut,locations,branchId,onBranch,reloadLocations}:{
  user:StaffIdentity; onSignOut:()=>void; locations:Locations; branchId:string; onBranch:(id:string)=>void; reloadLocations:()=>void;
}){
const branch = locations.branches.find(item => item.id === branchId);
const [approvalId,setApprovalId]=useState('');
const canNavigate=(name:string)=>user.role==='ADMIN'||name==='Settings'||(name==='Shops & Branches' && Boolean(branch?.manager || branch?.permissions.includes('Reports')))||user.permissions.includes(name);

const [page,setPage]=useState<string>(()=>nav.find(([name])=>canNavigate(name))?.[0]??'Settings');const [salesRevision,setSalesRevision]=useState(0);const [categories,setCategories]=useState<Category[]>([]);const [stats,setStats]=useState<Dashboard|null>(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [modal,setModal]=useState<'product'|'category'|null>(null);const [form,setForm]=useState(initial);const [productVariants,setProductVariants]=useState([initialVariant]);const [categoryName,setCategoryName]=useState('');const [parentId,setParentId]=useState('');const [search,setSearch]=useState('');const [saving,setSaving]=useState(false);const [formError,setFormError]=useState('');const [photo,setPhoto]=useState('');const [photoBusy,setPhotoBusy]=useState(false);const [categoryFilters,setCategoryFilters]=useState(emptyFilters);const [selection,setSelection]=useState<Selection|null>(null);const [importing,setImporting]=useState(false);const [notice,setNotice]=useState('');
async function refresh(){setSalesRevision(value=>value+1);setLoading(true);setError('');try{const [c,s]=await Promise.all([(['Categories','Products','Dashboard','Quick Sale'].some(canNavigate)?api<Category[]>('/categories'):Promise.resolve([])),canNavigate('Dashboard')?api<Dashboard>('/dashboard'):Promise.resolve(null)]);setCategories(c);setStats(s)}catch(e){setError((e as Error).message)}finally{setLoading(false)}}
useEffect(()=>{void refresh()},[]);
useEffect(()=>{
  if (!modal || saving) return;
  const closeOnEscape=(event:KeyboardEvent)=>{if(event.key==='Escape')setModal(null)};
  window.addEventListener('keydown',closeOnEscape);
  return ()=>window.removeEventListener('keydown',closeOnEscape);
},[modal,saving]);
async function signOut(){try{await send('/auth/logout','POST');onSignOut()}catch(e){setError((e as Error).message)}}
function openEditor(editor:'product'|'category'){setFormError('');setModal(editor)}
async function selectPhoto(file?:File){setPhotoBusy(true);setFormError('');try{setPhoto(file?await prepareProductPhoto(file):'')}catch(e){setPhoto('');setFormError((e as Error).message)}finally{setPhotoBusy(false)}}
async function addProduct(e:React.FormEvent){e.preventDefault();setSaving(true);setFormError('');try{await api('/products',{method:'POST',body:JSON.stringify({sku:form.sku,name:form.name,categoryId:form.categoryId,costPrice:Number(form.costPrice),salePrice:Number(form.salePrice),image:photo||undefined,variants:productVariants.map(variant=>({sku:[form.sku,variant.size,variant.color].map(part=>part.trim().replace(/\s+/g,'-')).join('-'),size:variant.size,color:variant.color,availableQty:Number(variant.qty),reorderPoint:5}))})});setModal(null);setForm(initial);setProductVariants([initialVariant]);setPhoto('');await refresh();setPage('Products')}catch(e){setFormError((e as Error).message)}finally{setSaving(false)}}
async function addCategory(e:React.FormEvent){e.preventDefault();setSaving(true);setFormError('');try{await api('/categories',{method:'POST',body:JSON.stringify({name:categoryName,parentId:parentId||null})});setModal(null);setCategoryName('');setParentId('');await refresh();setPage('Categories')}catch(e){setFormError((e as Error).message)}finally{setSaving(false)}}
async function archive(p:Pick<Product,'id'|'name'>){if(!window.confirm(`Archive ${p.name}? Historical records remain.`))return;try{await api('/products/'+p.id+'?emptyOnly=true',{method:'DELETE'});await refresh()}catch(e){setError((e as Error).message)}}
return <div className={page==='Dashboard'?'shell studio-shell studio-dashboard-page':'shell studio-shell'}><aside className="sidebar"><div className="brand"><div className="brand-icon"><Package size={23}/></div><div><strong>GarmentPro</strong><small>Warehouse Management</small></div></div><p className="side-label">WORKSPACE</p><nav>{nav.filter(([name])=>canNavigate(name)).map(([name,Icon])=><button key={name} className={'nav-link '+(page===name?'active':'')} aria-label={name} title={name} onClick={()=>setPage(name)}><Icon size={19}/>{name}</button>)}</nav><div className="side-foot"><div className="brand-icon tiny"><Boxes size={19}/></div><div><b>Codes TechVista</b><small>Powered by Codes TechVista</small></div></div></aside><main className="main"><header className="topbar"><div><h1>{page}</h1><p>{page==='Dashboard'?'Your warehouse overview, all in one place':'Garment warehouse and distribution management'}</p></div><div className="toolbar">{locations.branches.length > 0 && <label className="branch-selector">Branch
<select value={branchId} onChange={event=>onBranch(event.target.value)}>
{locations.legacyAllowed && <option value="">Original workspace</option>}
{locations.branches.map(item=><option key={item.id} value={item.id}>{item.shop.name} / {item.name}</option>)}
</select></label>}{canNavigate('Products')&&<div className="search"><Search size={17}/><input placeholder="Search products or SKU..." maxLength={100} aria-label="Global product search" value={search} onChange={e=>setSearch(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')setPage('Products')}}/></div>}<button aria-label="Refresh" className="iconbtn" onClick={()=>void refresh()}><RefreshCw size={18}/></button>{(canNavigate('Dashboard')||canNavigate('Inventory / Stock'))&&<StockNotifications revision={salesRevision} onApprove={user.role==='ADMIN'?id=>{setApprovalId(id);setPage('Staff & Permissions');}:undefined} onProduct={sku=>{if(canNavigate('Products')){setSearch(sku);setPage('Products')}}}/>}<div className="user"><span>{user.displayName.slice(0,2).toUpperCase()}</span><div><b>{user.displayName}</b><small>{roleNames[user.role]}</small></div></div><button aria-label="Sign out" title="Sign out" className="iconbtn" onClick={()=>void signOut()}><LogOut size={18}/></button></div></header><div className="content">{error&&<div className="error"><AlertCircle size={17}/>{error}<button onClick={()=>setError('')}><X size={16}/></button></div>}{loading&&<div className="hint">Loading warehouse data...</div>}{notice&&<div className="catalogue-notice" role="status"><span>{notice}</span><button className="textbtn" onClick={()=>setNotice('')}>Dismiss</button></div>}
{page==='Dashboard'&&<WarehouseDashboard categories={categories} stock={stats} search={search} onSearch={setSearch}
  revision={salesRevision} onAddProduct={canNavigate('Products')?()=>openEditor('product'):undefined} onAddCategory={canNavigate('Categories')?()=>openEditor('category'):undefined}
  onProducts={canNavigate('Products')?()=>setPage('Products'):undefined} onInventory={canNavigate('Inventory / Stock')?()=>setPage('Inventory / Stock'):undefined} onPurchases={canNavigate('Purchases')?()=>setPage('Purchases'):undefined} onReports={canNavigate('Reports')?()=>setPage('Reports'):undefined} onQuickSale={canNavigate('Quick Sale')?()=>setPage('Quick Sale'):undefined}
  onArchiveProduct={canNavigate('Products')?(id,name)=>{void archive({id,name});}:undefined}/>}
{page==='Dashboard'&&user.role==='ADMIN'&&<SalesDashboard revision={salesRevision}/>}
{page==='Quick Sale'&&<QuickSale categories={categories} revision={salesRevision} onChange={()=>void refresh()}/> }
{page==='Products'&&<section className="panel"><div className="panel-head"><div><h2>All Products</h2><p>Search and manage garment products with size and color variants</p></div><div className="warehouse-actions"><button className="textbtn detail-link" onClick={()=>setImporting(true)}><Upload size={15}/> Import products</button><button className="primary" onClick={()=>openEditor('product')}><Plus size={17}/>New Product</button></div></div><ProductCatalogue search={search} onSearch={setSearch} categories={categories} revision={salesRevision} onSelect={setSelection}/></section>}
{page==='Categories'&&<section className="panel"><div className="panel-head"><div><h2>Categories</h2><p>Organize products by apparel category</p></div><button className="primary" onClick={()=>openEditor('category')}><Plus size={17}/>Add Category</button></div><ListFilters label="Find categories" dateLabel="Category created" onApply={setCategoryFilters}/><CategoryGroups categories={categories} filters={categoryFilters} onSelect={setSelection}/></section>}
{page==='Inventory / Stock'&&<Inventory allowUnlinkedReturns={user.role==='ADMIN'} onStockChange={()=>void refresh()}/>}
{page==='Purchases'&&<><Purchases onStockChange={()=>void refresh()}/>{user.role==='WAREHOUSE'&&<Suppliers/>}</>}
{page==='Customers / Suppliers'&&<><Customers/><Suppliers/></>}
{page==='Sales & Distribution'&&<Sales key='sales' role={user.role} permissions={user.permissions} onChange={()=>void refresh()}/>}
{page==='Payments'&&<Sales key='payments' role={user.role} permissions={user.permissions} paymentsOnly onChange={()=>void refresh()}/>}
{page==='Reports'&&<FinancialReports revision={salesRevision}/>}
{page==='Day Look'&&<DayLook revision={salesRevision} location={branch ? branch.shop.name + ' / ' + branch.name : undefined}/>}
{page==='Activity Logs'&&<ActivityLogs revision={salesRevision}/>}
{page==='Returns'&&<Sales key='returns' role={user.role} permissions={user.permissions} returnsOnly onChange={()=>void refresh()}/>}
{page==='Staff & Permissions'&&user.role==='ADMIN'&&<WorkspaceSettings user={user} onSignOut={onSignOut} staffOnly review={{id:approvalId,onOpened:()=>setApprovalId(''),onSaved:()=>setSalesRevision(value=>value+1)}}/>}
{page==='Shops & Branches'&&<BranchSettings locations={locations} branch={branch} admin={user.role==='ADMIN'} onChange={reloadLocations}/>}
{page==='Settings'&&<WorkspaceSettings user={user} onSignOut={onSignOut}/>}
<footer>GarmentPro • Warehouse Management • Codes TechVista</footer></div></main>
{selection&&<CatalogueManagement selection={selection} categories={categories} onClose={()=>setSelection(null)} onChange={()=>void refresh()}/>}
{importing&&<BulkImport onClose={()=>setImporting(false)} onImported={result=>{setNotice('Imported '+result.products+(result.products===1?' product':' products')+' and '+result.variants+(result.variants===1?' variant.':' variants.'));void refresh()}}/>}
{modal&&<div className="backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!saving)setModal(null)}}><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="catalogue-editor-title"><div className="modal-head"><h2 id="catalogue-editor-title">{modal==='product'?'Add New Product':'Add Category'}</h2><button aria-label="Close dialog" className="iconbtn" disabled={saving} onClick={()=>setModal(null)}><X/></button></div>{formError&&<p role="alert" className="error">{formError}</p>}{modal==='category'?<form onSubmit={addCategory}><label>Category name<input autoFocus required value={categoryName} onChange={e=>setCategoryName(e.target.value)} placeholder="e.g. Jackets"/></label><label>Parent category (optional)<select value={parentId} onChange={e=>setParentId(e.target.value)}><option value="">Create a top-level category</option><CategoryOptions categories={categories}/></select></label><div className="actions"><button type="button" onClick={()=>setModal(null)}>Cancel</button><button className="primary" disabled={saving}>Save Category</button></div></form>:<form onSubmit={addProduct}><div className="form-grid"><label>Product name<input autoFocus required value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="e.g. Classic Polo Shirt"/></label><label>Product SKU<input required value={form.sku} onChange={e=>setForm({...form,sku:e.target.value})} placeholder="e.g. PL-001"/></label><label>Category<select required value={form.categoryId} onChange={e=>setForm({...form,categoryId:e.target.value})}><option value="">Choose category</option><CategoryOptions categories={categories}/></select></label><label>Cost price (PKR)<input type="number" min="0" step="0.01" required value={form.costPrice} onChange={e=>setForm({...form,costPrice:e.target.value})}/></label><label>Selling price (PKR)<input type="number" min="0" step="0.01" required value={form.salePrice} onChange={e=>setForm({...form,salePrice:e.target.value})}/></label><label>Product photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving||photoBusy} onChange={e=>void selectPhoto(e.target.files?.[0])}/>{photo&&<img className="product-photo-preview" src={photo} alt="Product photo preview"/>}</label></div><fieldset className="permission-list">
<legend>Size and color stock</legend>
{productVariants.map((variant,index)=>{
  const update=(field: keyof typeof initialVariant,value: string)=>setProductVariants(rows=>rows.map((row,i)=>i===index?{...row,[field]:value}:row));
  return <div className="form-grid" key={index} style={{gridColumn:'1 / -1'}}>
    <label>Color<input required value={variant.color} onChange={e=>update('color',e.target.value)}/></label>
    <label>Size<input required value={variant.size} onChange={e=>update('size',e.target.value)}/></label>
    <label>Opening stock (pieces)<input type="number" min="0" max="2147483647" required value={variant.qty} onChange={e=>update('qty',e.target.value)}/></label>
    {productVariants.length>1&&<button type="button" className="textbtn" onClick={()=>setProductVariants(rows=>rows.filter((_,i)=>i!==index))}>Remove variant</button>}
  </div>;
})}
<button type="button" className="textbtn" onClick={()=>setProductVariants(rows=>[...rows,{size:'',color:rows[rows.length - 1]?.color??'',qty:'0'}])}>Add size / color</button>
</fieldset><div className="actions"><button type="button" onClick={()=>setModal(null)}>Cancel</button><button className="primary" disabled={saving||photoBusy}>{photoBusy?'Preparing photo…':saving?'Saving...':'Save Product'}</button></div></form>}</div></div>}</div>}
function CategoryGroups({categories,filters,onSelect}:{categories:Category[];filters:typeof emptyFilters;onSelect:(selection:Selection)=>void}) {
  const active = Boolean(filters.search || filters.from || filters.to);
  const roots = categories.filter(item=>!item.parentId || !categories.some(parent=>parent.id===item.parentId));
  const groups = roots.map(root=>{
    const children = categories.filter(item=>item.parentId===root.id);
    return {root, children, visible:children.filter(item=>matchesFilters(filters,item.createdAt,item.name,root.name))};
  }).filter(group=>matchesFilters(filters,group.root.createdAt,group.root.name)||group.visible.length);
  function actions(item:Category){return <CatalogueActions name={item.name} active={item.active} canDelete={!item._count.products&&!item._count.children} onAction={action=>onSelect({kind:'category',item,action})}/>;}
  return groups.length ? <div className="category-groups">
    {groups.map(({root,children,visible})=><details key={root.id} open={active||undefined}>
      <summary><Tags size={17}/><strong>{root.name}</strong><span>{children.length} subcategories · {root._count.products+children.reduce((sum,child)=>sum+child._count.products,0)} products</span><strong className={root.active?'status healthy':'status warning'}>{root.active?'Active':'Inactive'}</strong>{actions(root)}</summary>
      {visible.length ? <ul>{visible.map(child=><li key={child.id}><b>{child.name}</b><span>{child._count.products} products</span><strong className={child.active?'status healthy':'status warning'}>{child.active?'Active':'Inactive'}</strong>{actions(child)}</li>)}</ul> : <p className="hint">No matching subcategories.</p>}
    </details>)}
  </div> : <Empty text="No matching categories."/>;
}
function ProductCatalogue({search,onSearch,categories,revision,onSelect}:{search:string;onSearch:(value:string)=>void;categories:Category[];revision:number;onSelect:(selection:Selection)=>void}) {
  const [page,setPage]=useState(1);
  const [sort,setSort]=useState('newest');
  const [appliedSearch,setAppliedSearch]=useState(search);
  const [dates,setDates]=useState({from:'',to:''});
  const [categoryId,setCategoryId]=useState('');
  const [status,setStatus]=useState('all');
  useEffect(()=>{
    const timer=window.setTimeout(()=>{setAppliedSearch(search);setPage(1)},200);
    return ()=>window.clearTimeout(timer);
  },[search]);
  const params=new URLSearchParams({search:appliedSearch,sort,status,page:String(page)});
  if (categoryId) { params.set('categoryId',categoryId); params.set('includeChildren','true'); }
  if (dates.from) params.set('from',dates.from);
  if (dates.to) params.set('to',dates.to);
  const query=useQuery<{items:Product[];total:number}>('/products?'+params,{items:[],total:0},revision);
  const pages=Math.max(1,Math.ceil(query.data.total/25));
  useEffect(()=>{if(!query.loading&&!query.error&&page>pages)setPage(pages)},[query.loading,query.error,page,pages]);
  return <>
    <ListFilters label="Find products" dateLabel="Product created" initialSearch={search}
      onApply={filters=>{onSearch(filters.search);setAppliedSearch(filters.search);setDates(filters);setPage(1)}}>
      <label>Category<select value={categoryId} onChange={event=>{setCategoryId(event.target.value);setPage(1)}}>
        <option value="">All categories</option><CategoryOptions categories={categories}/>
      </select></label>
      <label>Product status<select value={status} onChange={event=>{setStatus(event.target.value);setPage(1)}}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="out">Coming Soon</option></select></label>
      <label>Sort products<select value={sort} onChange={event=>{setSort(event.target.value);setPage(1)}}>
        <option value="newest">Newest first</option><option value="name">Product name</option><option value="sku">SKU</option>
        <option value="serial">Category and serial</option><option value="price">Lowest selling price</option>
      </select></label>
    </ListFilters>
    <QueryStatus {...query}/>
    {!query.loading&&!query.error&&<ProductTable items={query.data.items} onSelect={onSelect}/>}
    {pages>1&&<div className="actions">
      <button disabled={query.loading||page===1} onClick={()=>setPage(page-1)}>Previous</button>
      <span className="hint">Page {page} of {pages}</span>
      <button disabled={query.loading||page>=pages} onClick={()=>setPage(page+1)}>Next</button>
    </div>}
  </>;
}
function Empty({text}:{text:string}){return <p className="empty">{text}</p>}
function ProductTable({items,onSelect}:{items:Product[];onSelect:(selection:Selection)=>void}) {
  return <div className="table-scroll"><table className="product-management-table">
    <thead><tr><th>Product</th><th>Serial</th><th>SKU</th><th>Category</th><th>Variants</th><th>On hand</th><th>Cost</th><th>Selling price</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>{items.map(item=>{
      const status=!item.saleActive?'Inactive':item.totalQty===0?'Coming Soon':item.variants.some(variant=>variant.availableQty<=variant.reorderPoint)?'Low stock':'Available';
      return <tr key={item.id}>
        <td><div className="stock-product">{item.image?<img className="product-thumbnail" src={base+'/products/'+item.id+'/image'} alt="" loading="lazy"/>:<span className="stock-no-photo" aria-hidden="true">—</span>}<b>{item.name}</b></div></td>
        <td>{item.serialNumber}</td><td className="mono">{item.sku}</td><td>{item.category.name}</td>
        <td>{item.variants.map(variant=>variant.color+' / '+variant.size).join(', ')}</td><td>{item.totalQty.toLocaleString()}</td>
        <td>{formatProductPrice(item.costPrice)}</td><td>{formatProductPrice(item.salePrice)}</td>
        <td><span className={'status '+(status==='Available'?'healthy':'warning')}>{status}</span></td>
        <td><CatalogueActions name={item.name} active={item.active} canDelete={item.totalQty===0} onAction={action=>onSelect({kind:'product',item,action})}/></td>
      </tr>;
    })}</tbody>
  </table>{!items.length&&<Empty text="No products found. Add one to get started."/>}</div>;
}
export default App;
