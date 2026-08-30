import { DatePipe, JsonPipe, isPlatformBrowser } from '@angular/common';
import { Component, Inject, OnInit, PLATFORM_ID, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ApiClient, AuditProjection } from '../../core/api-client';
import { AppNav } from '../../shared/app-nav';
import { demoAudit } from './record-demo';

@Component({selector:'app-evidence-page',imports:[AppNav,RouterLink,DatePipe,JsonPipe],templateUrl:'./evidence-page.html',styleUrl:'./evidence-page.css'})
export class EvidencePage implements OnInit{
  readonly view:'merchant'|'auditor';readonly id:string;readonly projection=signal<AuditProjection|null>(null);readonly facts=signal<Record<string,unknown>|null>(null);readonly demo=signal(false);readonly loading=signal(true);readonly error=signal('');
  constructor(route:ActivatedRoute,private readonly api:ApiClient,@Inject(PLATFORM_ID) private readonly platformId:object){this.view=(route.snapshot.data['evidenceView']??'merchant') as 'merchant'|'auditor';this.id=route.snapshot.paramMap.get('recordId')??'demo'}
  ngOnInit():void{if(this.id==='demo'||!isPlatformBrowser(this.platformId)){this.useDemo();return}const request=this.view==='merchant'?this.api.getMerchantVerification(this.id):this.api.getAuditorEvidence(this.id);request.subscribe({next:(result)=>{this.projection.set(result);if('facts'in result)this.facts.set(result.facts as Record<string,unknown>);this.loading.set(false)},error:(error:Error)=>{this.error.set(error.message);this.loading.set(false)}})}
  label(value:string):string{return value.toLowerCase().replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase())}
  private useDemo():void{const all=demoAudit();const merchantTypes=new Set(['MANDATE_AUTHORIZED','CHECKOUT_CREATED','MANDATE_EVALUATED','HUMAN_APPROVAL_GRANTED','PAYMENT_AUTHORIZATION_CREATED','PAYMENT_CREDENTIAL_ISSUED','PAYMENT_SUCCEEDED','ORDER_AND_RECEIPT_CREATED']);this.projection.set({...all,events:this.view==='merchant'?all.events.filter(event=>merchantTypes.has(event.eventType)):all.events});if(this.view==='auditor')this.facts.set({mandate:{id:'demo-mandate',status:'ACTIVE'},mandateVersion:{version:1,maxTotalMinor:'15000'},checkout:{totalMinor:'13000',currency:'USD',status:'COMPLETED'},approval:{decision:'APPROVED'},credentialMetadata:{provider:'MOCK_SPT',status:'CONSUMED'},transaction:{status:'SUCCEEDED'},order:{merchantOrderId:'VY-ORDER-84M2Q'}});this.demo.set(true);this.loading.set(false)}
}
