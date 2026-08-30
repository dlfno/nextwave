import { DatePipe, DecimalPipe, isPlatformBrowser } from '@angular/common';
import { Component, Inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { finalize, forkJoin } from 'rxjs';
import { ApiClient, AuditProjection, TransactionDetail } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';
import { demoAudit, demoTransaction } from './record-demo';

@Component({ selector:'app-transaction-page',imports:[AppNav,RouterLink,DatePipe,DecimalPipe,FormsModule],templateUrl:'./transaction-page.html',styleUrl:'./transaction-page.css' })
export class TransactionPage implements OnInit {
  readonly id:string; readonly detail=signal<TransactionDetail|null>(null); readonly audit=signal<AuditProjection|null>(null); readonly loading=signal(true); readonly demo=signal(false); readonly tab=signal<'record'|'audit'>('record'); readonly disputeOpen=signal(false); readonly busy=signal(false); readonly error=signal(''); readonly disputeId=signal<string|null>(null);
  reasonCode='PURCHASE_NOT_RECOGNIZED'; statement='';
  constructor(route:ActivatedRoute,private readonly api:ApiClient,@Inject(PLATFORM_ID) private readonly platformId:object){this.id=route.snapshot.paramMap.get('transactionId')??'demo'}
  ngOnInit():void{if(this.id==='demo'||!isPlatformBrowser(this.platformId)){this.useDemo();return}forkJoin({detail:this.api.getTransaction(this.id),audit:this.api.getTransactionAudit(this.id)}).subscribe({next:({detail,audit})=>{this.detail.set(detail);this.audit.set(audit);this.loading.set(false)},error:(error:Error)=>{this.error.set(error.message);this.loading.set(false)}})}
  openDispute():void{if(!this.statement.trim()&&this.reasonCode==='OTHER'){this.error.set('Add a short statement for this dispute.');return}this.busy.set(true);this.error.set('');if(this.demo()){window.setTimeout(()=>{this.disputeId.set('demo-dispute');this.disputeOpen.set(false);this.busy.set(false)},350);return}this.api.openDispute(this.id,this.reasonCode,this.statement.trim()||undefined).pipe(finalize(()=>this.busy.set(false))).subscribe({next:({dispute})=>{this.disputeId.set(dispute.id);this.disputeOpen.set(false)},error:(error:Error)=>this.error.set(error.message)})}
  money(value:string):number{return Number(value)/100} label(value:string):string{return value.toLowerCase().replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase())}
  private useDemo():void{this.demo.set(true);this.detail.set(demoTransaction());this.audit.set(demoAudit());this.loading.set(false)}
}
