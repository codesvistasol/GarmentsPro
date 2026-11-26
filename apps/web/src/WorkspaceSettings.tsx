import { useEffect, useState } from 'react';
import { send } from './api';
import { Editor, QueryStatus, useQuery } from './warehouse-ui';
import { roleNames, type StaffIdentity, type Role } from './StaffLogin';
import { prepareProductPhoto } from './product-photo';

type Business = { companyName: string; address: string; email: string; phone: string; invoiceFooter: string;
  invoiceLogo: string | null; invoiceLogoPlacement: 'HEADER' | 'WATERMARK' | 'BOTH'; invoiceTimeZone: string };
type Staff = StaffIdentity & { active: boolean; signupPending?: boolean; branchOnly?: boolean };
const blankBusiness: Business = {companyName:'GarmentPro',address:'',email:'',phone:'',invoiceFooter:'',
  invoiceLogo: null, invoiceLogoPlacement: 'HEADER', invoiceTimeZone: 'Asia/Karachi'};
const presets: Record<Role, string[]> = {
  ADMIN: [], WAREHOUSE: ['Dashboard','Products','Categories','Inventory / Stock','Purchases','Sales & Distribution'],
  SALES: ['Quick Sale','Sales & Distribution','Customers / Suppliers','Payments'],
  FINANCE: ['Sales & Distribution','Payments','Reports','Day Look','Returns'],
};
const permissionOptions = [...new Set([...Object.values(presets).flat(), 'Activity Logs'])];
const blankStaff: Staff = { id:'', username:'', displayName:'', role:'WAREHOUSE', active:true, permissions: presets.WAREHOUSE };

type SignupReview = { id: string; onOpened: () => void; onSaved: () => void };
export default function WorkspaceSettings({ user, onSignOut, staffOnly = false, review }: {
  user: StaffIdentity; onSignOut: () => void; staffOnly?: boolean; review?: SignupReview;
}) {
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  if (staffOnly) return user.role === 'ADMIN' ? <AdminSettings ownId={user.id} staffOnly review={review}/> : null;
  return <>
    <section className="panel warehouse-panel">
      <div className="panel-head"><div><h2>Your account</h2><p>{user.displayName} · {roleNames[user.role]}</p></div>
        <button className="primary" onClick={() => {setChanging(true);setCurrent('');setNext('');}}>Change password</button></div>
    </section>
    {changing && <Editor title="Change password" onClose={()=>setChanging(false)} onSave={async ()=>{
      await send('/auth/password','POST',{current,next}); onSignOut();
    }}>
      <div className="form-grid">
        <label>Current password<input type="password" autoComplete="current-password" required value={current} onChange={e=>setCurrent(e.target.value)} /></label>
        <label>New password<input type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={next} onChange={e=>setNext(e.target.value)} /></label>
      </div>
    </Editor>}
    {user.role === 'ADMIN' && <AdminSettings ownId={user.id} />}
  </>;
}

function AdminSettings({ownId,staffOnly=false,review}:{ownId:string;staffOnly?:boolean;review?:SignupReview}) {
  const [revision,setRevision]=useState(0);
  const business=useQuery<Business>('/settings/business',blankBusiness,revision,!staffOnly);
  const users=useQuery<Staff[]>('/settings/staff',[],revision,staffOnly);
  const [company,setCompany]=useState<Business|null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoInput, setLogoInput] = useState(0);
  const [staff,setStaff]=useState<Staff|null>(null);
  const [password,setPassword]=useState('');
  const [reset, setReset] = useState<{ username: string; code: string } | null>(null);
  const [resetError, setResetError] = useState('');
  const [resetting, setResetting] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const notifyApproval = review?.onSaved;
  useEffect(() => {
    if (!review?.id || users.loading || users.error) return;
    const account = users.data.find(user => user.id === review.id && user.signupPending);
    if (account) { setStaff({...account, active:true}); setPassword(''); setApprovalError(''); }
    else setApprovalError('This sign-up request has already been handled.');
    review.onOpened();
  }, [review, users.data, users.loading, users.error]);
  const reload=()=>setRevision(value=>value+1);

  return <>
    {!staffOnly && <section className="panel warehouse-panel">
      <div className="panel-head"><div><h2>Invoice settings</h2><p>Saved on new invoices when they are issued.</p></div>
        <button className="primary" disabled={business.loading || !!business.error} onClick={()=>{
          const { companyName,address,email,phone,invoiceFooter,invoiceLogo,invoiceLogoPlacement,invoiceTimeZone }=business.data;
          setLogoFile(null);
          setCompany({ companyName,address,email,phone,invoiceFooter,invoiceLogo,invoiceLogoPlacement,invoiceTimeZone });
        }}>Edit invoice details</button></div>
      <QueryStatus {...business}/>
      {!business.loading && !business.error && <dl className="catalogue-details"><div><dt>Business</dt><dd>{business.data.companyName}</dd></div>
        <div><dt>Contact</dt><dd>{[business.data.email,business.data.phone].filter(Boolean).join(' · ')||'—'}</dd></div></dl>}
    </section>}
    {staffOnly && <section className="panel warehouse-panel">
      <div className="panel-head"><div><h2>Staff accounts and permissions</h2><p>Verify each new staff member’s identity before approving access. Choose the modules they can open.</p></div><button className="primary" onClick={()=>{setStaff(blankStaff);setPassword('')}}>Add staff account</button></div>
      <QueryStatus {...users}/>
      {approvalError && <p className="error" role="alert">{approvalError}</p>}
      {resetError && <p className="error" role="alert">{resetError}</p>}
      {reset && <div className="catalogue-notice" role="status">
        <div>Share this one-time code privately with {reset.username}. It expires in 15 minutes.
          <div><code>{reset.code}</code></div></div>
        <button className="textbtn" onClick={()=>setReset(null)}>Dismiss</button>
      </div>}
      <div className="table-scroll"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>{users.data.map(item=><tr key={item.id}><td>{item.username}</td><td>{item.displayName}</td><td>{roleNames[item.role]}</td>
          <td>{item.active?'Active':item.signupPending?'Awaiting approval':'Inactive'}</td><td><div className="warehouse-actions">
            <button className="textbtn detail-link" onClick={()=>{setStaff(item.signupPending?{...item,active:true}:item);setPassword('');}}>{item.signupPending?'Approve request':'Edit permissions'}</button>
            {item.active && <button className="textbtn detail-link" disabled={resetting} onClick={async()=>{
              setResetting(true);setResetError('');setReset(null);
              try {
                const { code } = await send<{code: string}>('/settings/staff/'+item.id+'/reset-code','POST');
                setReset({username:item.username,code});
              } catch (error) {setResetError((error as Error).message);}
              finally {setResetting(false);}
            }}>Generate reset code</button>}
          </div></td></tr>)}</tbody>
      </table></div>
    </section>}
    {company && <Editor title="Edit invoice details" onClose={()=>setCompany(null)} onSave={async()=>{
      const invoiceLogo = logoFile ? await prepareProductPhoto(logoFile) : company.invoiceLogo;
      await send('/settings/business','PATCH',{...company, invoiceLogo});reload();
    }}><div className="form-grid">
      <label>Business name<input required minLength={2} maxLength={100} value={company.companyName} onChange={e=>setCompany({...company,companyName:e.target.value})}/></label>
      <label>Address<input maxLength={300} value={company.address} onChange={e=>setCompany({...company,address:e.target.value})}/></label>
      <label>Email<input type="email" maxLength={240} value={company.email} onChange={e=>setCompany({...company,email:e.target.value})}/></label>
      <label>Phone<input maxLength={40} value={company.phone} onChange={e=>setCompany({...company,phone:e.target.value})}/></label>
      <label>Invoice footer<input maxLength={250} value={company.invoiceFooter} onChange={e=>setCompany({...company,invoiceFooter:e.target.value})}/></label>
      <label>Invoice time zone<input required maxLength={80} placeholder="Asia/Karachi" value={company.invoiceTimeZone}
        onChange={e=>setCompany({...company,invoiceTimeZone:e.target.value})}/></label>
      <label>Shop logo<input key={logoInput} type="file" accept="image/jpeg,image/png,image/webp"
        onChange={e=>setLogoFile(e.target.files?.[0] ?? null)}/></label>
      <label>Logo placement<select value={company.invoiceLogoPlacement}
        onChange={e=>setCompany({...company,invoiceLogoPlacement:e.target.value as Business['invoiceLogoPlacement']})}>
        <option value="HEADER">Header logo</option>
        <option value="WATERMARK">Background watermark</option>
        <option value="BOTH">Header logo and watermark</option>
      </select></label>
      {(company.invoiceLogo || logoFile) && <div>
        {company.invoiceLogo && !logoFile && <img className="product-photo-preview" src={company.invoiceLogo} alt="Saved shop logo"/>}
        <button className="textbtn" type="button" onClick={()=>{
          setLogoFile(null);
          setLogoInput(value=>value+1);
          setCompany({...company,invoiceLogo:null});
        }}>Remove logo</button>
      </div>}
    </div></Editor>}
    {staff && <Editor title={staff.signupPending?'Approve sign-up request':staff.id?'Edit staff account':'Add staff account'}
      save={staff.signupPending?'Approve account':undefined} onClose={()=>setStaff(null)} onSave={async()=>{
      const { id,username,displayName,role,active,permissions,signupPending,branchOnly }=staff;
      await send('/settings/staff'+(id?'/'+id:''),id?'PATCH':'POST',
        id?{displayName,...(id===ownId?{}:{role,active,branchOnly,permissions:role==='ADMIN'?undefined:permissions,password:password||undefined,approveSignup:signupPending?true:undefined})}:{username,displayName,role,branchOnly,permissions:role==='ADMIN'?undefined:permissions,password});
      if (signupPending) notifyApproval?.();
      reload();
    }}><div className="form-grid">
      <label>Username or email<input required disabled={!!staff.id} minLength={3} maxLength={254} value={staff.username} onChange={e=>setStaff({...staff,username:e.target.value})}/></label>
      <label>Name<input required minLength={2} maxLength={100} value={staff.displayName} onChange={e=>setStaff({...staff,displayName:e.target.value})}/></label>
      <label>Role<select value={staff.role} disabled={staff.id===ownId} onChange={e=>{
        const role = e.target.value as Role;
        setStaff({...staff,role,permissions:presets[role]});
      }}>
        {Object.entries(roleNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}
      </select></label>
      {staff.id && !staff.signupPending && <label>Status<select disabled={staff.id===ownId} value={String(staff.active)} onChange={e=>setStaff({...staff,active:e.target.value==='true'})}>
        <option value="true">Active</option><option value="false">Inactive</option></select></label>}
      {staff.id!==ownId && <label>{staff.id?'New password (optional)':'Initial password'}<input type="password" autoComplete="new-password"
        minLength={12} maxLength={128} required={!staff.id} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
    </div>
    {staff.role !== 'ADMIN' && staff.id !== ownId && <fieldset className="permission-list"><legend>Workspace access</legend>
      <label><input type="checkbox" checked={staff.branchOnly ?? false} onChange={e=>setStaff({...staff,branchOnly:e.target.checked})}/>
        Assigned branches only</label>
    </fieldset>}
    {staff.role === 'ADMIN' ? <p>Administrators have access to all modules.</p> :
      <fieldset className="permission-list">
        <legend>Allowed modules</legend>
        {permissionOptions.map(module=><label key={module}><input type="checkbox" checked={staff.permissions.includes(module)}
          onChange={e=>setStaff({...staff,permissions:e.target.checked?[...staff.permissions,module]:staff.permissions.filter(value=>value!==module)})}/>
          {module}</label>)}
      </fieldset>}
    </Editor>}
  </>;
}
