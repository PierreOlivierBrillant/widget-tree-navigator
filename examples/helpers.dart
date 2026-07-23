// Third test fixture: helper methods declared with a CONCRETE widget return
// type rather than `Widget`, which is how most people actually write them.
//
// Everything here was reported as broken at least once:
//   - `_title()`, `_score()` and `_buttons()` were not listed at all, because
//     their return types are Text / Row / GridView instead of Widget;
//   - `NeverScrollableScrollPhysics()` WAS listed, although it is a scroll
//     physics, not a widget.
//
// The file also guards the other direction: `_label()` returns a String and
// `_delay()` returns a Duration, so neither may ever appear in the tree.

import 'package:flutter/material.dart';

class Game extends StatefulWidget {
  const Game({super.key});

  @override
  State<Game> createState() => _GameState();
}

class _GameState extends State<Game> {
  int _rabbitPosition = 0;
  int _scoreBonk = 0;
  int _scoreZloop = 0;

  String _label() => 'Score';

  Duration _delay() => const Duration(milliseconds: 300);

  void _newPosition() {
    setState(() {
      _rabbitPosition = (_rabbitPosition + 1) % 4;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [_title(), _score(), _buttons()],
        ),
      ),
    );
  }

  Text _title() {
    return Text(_label(), style: TextStyle(fontSize: 40));
  }

  Row _score() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [Text('$_scoreBonk'), Text('$_scoreZloop')],
    );
  }

  GridView _buttons() {
    return GridView.count(
      shrinkWrap: true,
      physics: NeverScrollableScrollPhysics(),
      crossAxisCount: 2,
      mainAxisSpacing: 20,
      crossAxisSpacing: 20,
      padding: EdgeInsets.all(20),
      children: List.generate(4, (index) {
        String emoji = _rabbitPosition == index ? "R" : "H";
        return ElevatedButton(
          onPressed: () {
            setState(() {
              if (index == _rabbitPosition) {
                _scoreBonk++;
              } else {
                _scoreZloop++;
              }
            });
            _newPosition();
          },
          child: Text(emoji, style: TextStyle(fontSize: 100)),
        );
      }),
    );
  }
}
