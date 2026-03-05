'use client'
import './index.css';
import styles from './index.module.less';
import React, { type PropsWithChildren } from 'react'

export const Name = (props: PropsWithChildren<{ name: string }>) => {
  const [clicked, setClicked] = React.useState(false);

  const click = () => {
    setClicked(true);
    console.log(`[name-clicked] ${props.name}`)
  }

  return (
    <div className={styles.red} style={{
      color: 'white',
      padding: '10px',
      borderRadius: '5px',
      margin: '10px',
      fontSize: '16px',
      fontWeight: 'bold',
    }}>
      <button type="button" onClick={click} data-testid={`name-btn-${props.name}`}>
        my name is {props.name} - {props.children}
      </button>
      <span data-testid={`name-status-${props.name}`}>{clicked ? 'clicked' : 'idle'}</span>
    </div>
  )
}
