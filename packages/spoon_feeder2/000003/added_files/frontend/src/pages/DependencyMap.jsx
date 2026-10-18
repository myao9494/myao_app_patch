/**
 * 依存関係マップ画面 (DependencyMap.jsx)
 *
 * 仕様:
 * 1. /map?path=... で開き、/api/dependency_map の結果をd3の力学レイアウトで描画する（ズーム・ドラッグ対応）。
 * 2. 包含 / import / 呼び出し の関係を個別に表示切替でき、ノード名で検索すると一致しないノードを薄く表示する。
 * 3. ノードをクリックすると種類・ID・所属を詳細パネルに表示する。
 **/

import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { AlertTriangle, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../api';

export function DependencyMap() {
  const params = new URLSearchParams(location.search);
  const [path, setPath] = useState(params.get('path') || localStorage.getItem('spoonfeederPath') || '');
  const [data, setData] = useState({ nodes: [], edges: [] });
  const [filters, setFilters] = useState({ contains: true, import: true, calls: true });
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const svgRef = useRef(null);
  const load = async () => { try { setError(''); setData(await api('/api/dependency_map', { library_path: path })); } catch (err) { setError(err.message); } };
  useEffect(() => { if (path) load(); }, []);
  useEffect(() => {
    if (!svgRef.current || !data.nodes.length) return;
    const svg = d3.select(svgRef.current); svg.selectAll('*').remove();
    const width = svgRef.current.clientWidth, height = svgRef.current.clientHeight;
    const viewport = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.15, 4]).on('zoom', event => viewport.attr('transform', event.transform)));
    const nodes = data.nodes.map(item => ({ ...item }));
    const visibleEdges = data.edges.filter(edge => filters[edge.type]);
    const links = visibleEdges.map(item => ({ ...item }));
    const simulation = d3.forceSimulation(nodes).force('link', d3.forceLink(links).id(d => d.id).distance(d => d.type === 'contains' ? 50 : 150)).force('charge', d3.forceManyBody().strength(-220)).force('center', d3.forceCenter(width / 2, height / 2)).force('collide', d3.forceCollide(22));
    const link = viewport.append('g').selectAll('line').data(links).join('line').attr('class', d => `graph-link ${d.type}`);
    const node = viewport.append('g').selectAll('g').data(nodes).join('g').attr('class', d => `graph-node ${d.type}`).call(d3.drag().on('start', (event, d) => { if (!event.active) simulation.alphaTarget(.3).restart(); d.fx = d.x; d.fy = d.y; }).on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; }).on('end', (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));
    node.append('circle').attr('r', d => d.type === 'file' ? 11 : d.type === 'class' ? 8 : 5).on('click', (_, d) => setSelected(d));
    node.append('text').attr('x', 13).attr('y', 4).text(d => d.label);
    simulation.on('tick', () => { link.attr('x1', d => d.source.x).attr('y1', d => d.source.y).attr('x2', d => d.target.x).attr('y2', d => d.target.y); node.attr('transform', d => `translate(${d.x},${d.y})`); });
    return () => simulation.stop();
  }, [data, filters]);
  useEffect(() => { if (!svgRef.current) return; d3.select(svgRef.current).selectAll('.graph-node').classed('dim', d => query && !d.label.toLowerCase().includes(query.toLowerCase())); }, [query]);
  return <div className="map-page"><svg ref={svgRef}/><aside className="map-controls"><div className="brand mini"><div className="logo">S</div><div><h1>Spoonfeeder Map</h1><p>Python + C# dependencies</p></div></div><label>解析パス</label><div className="map-path"><input value={path} onChange={event => setPath(event.target.value)}/><button onClick={load}><RefreshCw/></button></div><label>ノード検索</label><div className="search-box"><Search/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="名前を入力"/></div><label>関係を表示</label>{Object.keys(filters).map(key => <label className="switch-line compact" key={key}><span>{key === 'contains' ? '包含関係' : key === 'import' ? 'import / using' : '呼び出し'}</span><input type="checkbox" checked={filters[key]} onChange={event => setFilters({ ...filters, [key]: event.target.checked })}/></label>)}<div className="legend"><span><i className="file"/>ファイル</span><span><i className="class"/>クラス</span><span><i className="function"/>関数</span></div>{error && <div className="error-box"><AlertTriangle/>{error}</div>}<a href="/">← コンテキスト画面へ戻る</a></aside>{selected && <aside className="node-detail"><button onClick={() => setSelected(null)}><X/></button><span className="eyebrow">{selected.type}</span><h2>{selected.label}</h2><code>{selected.id}</code>{selected.parent && <p>所属<br/><strong>{selected.parent}</strong></p>}</aside>}</div>;
}
